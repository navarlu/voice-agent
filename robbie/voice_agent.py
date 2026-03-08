import asyncio
import json
import logging
import os
import re
from datetime import datetime, timezone
from pathlib import Path

import tiktoken
from dotenv import load_dotenv
from livekit.agents import (
    Agent,
    AgentSession,
    AutoSubscribe,
    JobContext,
    WorkerOptions,
    cli,
    llm,
    metrics,
    room_io,
)
from openai.types.beta.realtime.session import TurnDetection
from livekit.plugins import openai

from .config import (
    AGENT_VERSION,
    CHAT_CTX_DROP_TOOL_OUTPUTS,
    CHAT_CTX_AUTO_PRUNE_ON_TOKEN_CRITICAL,
    CHAT_CTX_CONTEXT_WINDOW_TOKENS,
    CHAT_CTX_MAX_ITEMS,
    CHAT_CTX_PRUNE_AFTER_ASSISTANT,
    CHAT_CTX_REAPPLY_INSTRUCTIONS,
    CHAT_CTX_TOKEN_CRITICAL_RATIO,
    CHAT_CTX_TOKEN_WARN_RATIO,
    LOG_CONSOLE_MODE,
    LOG_CONTEXT_WINDOW,
    LOG_COST_ESTIMATE,
    LOG_TOKEN_USAGE,
    MODEL_NAME,
    PIPELINE_MODE,
    REALTIME_TURN_INTERRUPT_RESPONSE,
    REALTIME_TURN_PREFIX_PADDING_MS,
    REALTIME_TURN_SILENCE_DURATION_MS,
    REALTIME_TURN_THRESHOLD,
    SYSTEM_PROMPT,
    TTS_VOICE,
    VOICE_AGENT_GREETING_INSTRUCTIONS,
    WEAVIATE_COLLECTION,
    WEAVIATE_OPENAI_MODEL,
)
from .observability import (
    collect_and_log_token_metric,
    configure_voice_logger,
    log_usage_summary_and_cost,
)
from .tools import build_tools
from .utils import connect_weaviate, ensure_collection_seeded_for_session


load_dotenv(dotenv_path=Path(__file__).parent.parent / ".env")
logger = logging.getLogger("voice-agent")
logger.propagate = True
if logger.handlers:
    logger.handlers.clear()
if not logging.getLogger().handlers:
    logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
configure_voice_logger(logger, console_mode=LOG_CONSOLE_MODE)


async def entrypoint(ctx: JobContext) -> None:
    logger.info("agent version=%s", AGENT_VERSION)

    logs_dir = Path(__file__).parent.parent / "logs"
    test_payload = {
        "event": "permission_test",
        "ts": datetime.now(timezone.utc).isoformat(),
    }
    try:
        logs_dir.mkdir(parents=True, exist_ok=True)
        test_path = logs_dir / "permission_test.json"
        test_path.write_text(json.dumps(test_payload, ensure_ascii=False) + "\n")
        logger.info("permission_test_write_ok path=%s", test_path)
    except Exception:
        logger.exception("permission_test_write_failed path=%s", logs_dir)

    await ctx.connect(auto_subscribe=AutoSubscribe.SUBSCRIBE_ALL)
    participant = await ctx.wait_for_participant()

    room_name = getattr(ctx.room, "name", "") or "room"
    participant_name = (getattr(participant, "name", "") or "").strip()
    participant_identity = (getattr(participant, "identity", "") or "").strip()
    participant_phone = (
        participant_identity
        or participant_name
        or getattr(participant, "sid", "")
        or "unknown"
    )
    logger.info(
        "session_start room=%s participant_name=%s participant_identity=%s participant_phone=%s "
        "agent_version=%s model_name=%s tts_voice=%s weaviate_collection=%s weaviate_embed_model=%s",
        room_name,
        participant_name,
        participant_identity,
        participant_phone,
        AGENT_VERSION,
        MODEL_NAME,
        TTS_VOICE,
        WEAVIATE_COLLECTION,
        WEAVIATE_OPENAI_MODEL,
    )

    with connect_weaviate() as client:
        seed_state = ensure_collection_seeded_for_session(client)
        exists = client.collections.exists(WEAVIATE_COLLECTION)
        logger.info(
            "weaviate_collection_ready name=%s exists=%s created=%s seeded=%s existing_count=%s inserted_count=%s final_count=%s",
            WEAVIATE_COLLECTION,
            exists,
            seed_state.get("created"),
            seed_state.get("seeded"),
            seed_state.get("existing_count", 0),
            seed_state.get("inserted_count", 0),
            seed_state.get("final_count", seed_state.get("existing_count", 0)),
        )

    if PIPELINE_MODE == "realtime":
        session = AgentSession(
            llm=openai.realtime.RealtimeModel(
                model=MODEL_NAME,
                voice=TTS_VOICE,
                api_key=os.getenv("OPENAI_API_KEY"),
                turn_detection=TurnDetection(
                    type="server_vad",
                    threshold=REALTIME_TURN_THRESHOLD,
                    prefix_padding_ms=REALTIME_TURN_PREFIX_PADDING_MS,
                    silence_duration_ms=REALTIME_TURN_SILENCE_DURATION_MS,
                    create_response=True,
                    interrupt_response=REALTIME_TURN_INTERRUPT_RESPONSE,
                ),
            ),
        )
    else:
        raise ValueError(f"Unsupported PIPELINE_MODE: {PIPELINE_MODE}")

    tools = build_tools()
    tool_names = [
        str(getattr(tool, "name", getattr(tool, "__name__", tool.__class__.__name__)))
        for tool in tools
    ]
    agent = Agent(
        instructions=SYSTEM_PROMPT,
        tools=tools,
    )
    logger.warning(
        "CALL_START room=%s participant_phone=%s participant_identity=%s participant_name=%s "
        "agent_version=%s model=%s tools=%s",
        room_name,
        participant_phone,
        participant_identity,
        participant_name,
        AGENT_VERSION,
        MODEL_NAME,
        ",".join(tool_names),
    )

    session_closed = asyncio.Event()
    prune_lock = asyncio.Lock()
    usage_collector = metrics.UsageCollector()
    last_ctx_pressure_level = "ok"
    locked_language = "cs"
    applied_language = ""
    observed_input_text_tokens_last = 0
    observed_input_text_tokens_max = 0
    try:
        tokenizer = tiktoken.encoding_for_model(MODEL_NAME)
    except KeyError:
        tokenizer = tiktoken.get_encoding("o200k_base")
    system_prompt_tokens = len(tokenizer.encode(SYSTEM_PROMPT))

    def _chat_item_as_text(item: object) -> str:
        text_content = getattr(item, "text_content", None)
        if isinstance(text_content, str) and text_content.strip():
            return text_content

        content = getattr(item, "content", None)
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            parts: list[str] = []
            for part in content:
                if isinstance(part, str):
                    parts.append(part)
                    continue
                part_text = getattr(part, "text", None)
                if isinstance(part_text, str):
                    parts.append(part_text)
            if parts:
                return "\n".join(parts)

        dumped = getattr(item, "model_dump", None)
        if callable(dumped):
            try:
                return json.dumps(dumped(), ensure_ascii=False, default=str)
            except Exception:
                return repr(item)
        return repr(item)

    def _estimate_chat_ctx_tokens(chat_ctx: llm.ChatContext) -> int:
        total = 0
        for item in getattr(chat_ctx, "items", []) or []:
            role = str(getattr(item, "role", "") or "")
            item_type = str(getattr(item, "type", "") or "")
            payload = _chat_item_as_text(item)
            if role:
                total += len(tokenizer.encode(role))
            if item_type:
                total += len(tokenizer.encode(item_type))
            if payload:
                total += len(tokenizer.encode(payload))
        return total

    async def _log_context_window_estimate(*, trigger: str, allow_auto_prune: bool = True) -> None:
        if not LOG_CONTEXT_WINDOW:
            return
        nonlocal last_ctx_pressure_level
        chat_ctx_filtered = llm.ChatContext.empty()
        chat_ctx_full = llm.ChatContext.empty()
        if CHAT_CTX_DROP_TOOL_OUTPUTS:
            chat_ctx_filtered.merge(session.history, exclude_function_call=True)
        else:
            chat_ctx_filtered.merge(session.history)
        chat_ctx_full.merge(session.history)

        estimated_tokens_filtered = _estimate_chat_ctx_tokens(chat_ctx_filtered)
        estimated_tokens_full = _estimate_chat_ctx_tokens(chat_ctx_full)
        estimated_tokens = estimated_tokens_filtered + system_prompt_tokens
        max_tokens = max(int(CHAT_CTX_CONTEXT_WINDOW_TOKENS or 0), 0)
        if max_tokens <= 0:
            logger.info(
                "context_window_estimate trigger=%s estimated_tokens=%s estimated_tokens_filtered=%s "
                "estimated_tokens_full=%s system_prompt_tokens=%s context_window_tokens=unknown",
                trigger,
                estimated_tokens,
                estimated_tokens_filtered,
                estimated_tokens_full,
                system_prompt_tokens,
            )
            return

        usage_ratio = estimated_tokens / max_tokens
        if usage_ratio >= CHAT_CTX_TOKEN_CRITICAL_RATIO:
            level = "critical"
        elif usage_ratio >= CHAT_CTX_TOKEN_WARN_RATIO:
            level = "warn"
        else:
            level = "ok"
        logger.info(
            "context_window_estimate trigger=%s estimated_tokens=%s estimated_tokens_filtered=%s "
            "estimated_tokens_full=%s system_prompt_tokens=%s context_window_tokens=%s usage_ratio=%.4f level=%s",
            trigger,
            estimated_tokens,
            estimated_tokens_filtered,
            estimated_tokens_full,
            system_prompt_tokens,
            max_tokens,
            usage_ratio,
            level,
        )
        crossed_to_critical = level == "critical" and last_ctx_pressure_level != "critical"
        last_ctx_pressure_level = level
        if crossed_to_critical and allow_auto_prune and CHAT_CTX_AUTO_PRUNE_ON_TOKEN_CRITICAL:
            logger.warning(
                "context_window_action action=auto_prune reason=critical_threshold trigger=%s",
                trigger,
            )
            await _prune_chat_ctx()

    @session.on("metrics_collected")
    def _on_metrics_collected(event) -> None:
        nonlocal observed_input_text_tokens_last
        nonlocal observed_input_text_tokens_max
        metric = getattr(event, "metrics", None)
        if metric is None:
            return
        collect_and_log_token_metric(
            logger=logger,
            usage_collector=usage_collector,
            metric=metric,
        )
        if not LOG_TOKEN_USAGE:
            return
        if isinstance(metric, metrics.RealtimeModelMetrics):
            input_text_tokens = int(metric.input_token_details.text_tokens or 0)
            observed_input_text_tokens_last = input_text_tokens
            if input_text_tokens > observed_input_text_tokens_max:
                observed_input_text_tokens_max = input_text_tokens
            logger.info(
                "context_window_observed request_id=%s input_text_tokens=%s max_input_text_tokens=%s",
                metric.request_id,
                observed_input_text_tokens_last,
                observed_input_text_tokens_max,
            )

    async def _prune_chat_ctx() -> None:
        async with prune_lock:
            chat_ctx = llm.ChatContext.empty()
            if CHAT_CTX_DROP_TOOL_OUTPUTS:
                chat_ctx.merge(session.history, exclude_function_call=True)
            else:
                chat_ctx.merge(session.history)

            if CHAT_CTX_MAX_ITEMS:
                chat_ctx.truncate(max_items=CHAT_CTX_MAX_ITEMS)

            await agent.update_chat_ctx(chat_ctx)
            if CHAT_CTX_REAPPLY_INSTRUCTIONS:
                await agent.update_instructions(SYSTEM_PROMPT)
            await _log_context_window_estimate(trigger="post_prune", allow_auto_prune=False)

    def _detect_locked_language(text: str, current: str) -> str:
        t = (text or "").lower()
        if not t:
            return current
        en_hits = sum(
            1
            for token in (
                "hello",
                "please",
                "thanks",
                "thank",
                "lost",
                "keys",
                "what",
                "where",
                "when",
                "how",
                "can you",
                "i need",
            )
            if token in t
        )
        cs_hits = sum(
            1
            for token in (
                "dobrý",
                "prosím",
                "děkuji",
                "ztratil",
                "klíče",
                "jak",
                "kde",
                "kdy",
                "můžete",
            )
            if token in t
        )
        if en_hits > cs_hits:
            return "en"
        if cs_hits > en_hits:
            return "cs"
        if re.search(r"[áčďéěíňóřšťúůýž]", t):
            return "cs"
        if re.search(r"[a-z]", t):
            return "en"
        return current

    async def _apply_language_lock(lang: str, reason: str) -> None:
        nonlocal applied_language
        if lang == applied_language:
            return
        language_lock = (
            "\n\n## Runtime language lock\n"
            "You must answer only in English until the user clearly switches back to Czech."
            if lang == "en"
            else "\n\n## Runtime language lock\n"
            "Musíš odpovídat pouze česky, dokud uživatel jasně nepřejde do angličtiny."
        )
        await agent.update_instructions(SYSTEM_PROMPT + language_lock)
        applied_language = lang
        logger.info("language_lock language=%s reason=%s", lang, reason)

    @session.on("close")
    def _on_close(_) -> None:
        logger.warning(
            "CALL_END room=%s participant_phone=%s participant_identity=%s participant_name=%s language=%s",
            room_name,
            participant_phone,
            participant_identity,
            participant_name,
            locked_language,
        )
        logger.info(
            "session_close room=%s participant_name=%s participant_identity=%s participant_phone=%s",
            room_name,
            participant_name,
            participant_identity,
            participant_phone,
        )
        session_closed.set()

    @session.on("conversation_item_added")
    def _on_conversation_item(event) -> None:
        nonlocal locked_language
        message = getattr(event, "item", None)
        if not message or getattr(message, "type", None) != "message":
            return
        role = getattr(message, "role", None)
        text = getattr(message, "text_content", None)
        if role == "user" and isinstance(text, str) and text.strip():
            next_lang = _detect_locked_language(text, locked_language)
            if next_lang != locked_language:
                locked_language = next_lang
                asyncio.create_task(
                    _apply_language_lock(locked_language, "user_state_change")
                )
        if role and text:
            """logger.info(
                "conversation_item room=%s participant_phone=%s role=%s created_at=%s text=%s",
                room_name,
                participant_phone,
                role,
                getattr(message, "created_at", None),
                text,
            )"""
            logger.info("conversation_item version=%s text=%s", AGENT_VERSION, text)
        asyncio.create_task(_log_context_window_estimate(trigger="conversation_item_added"))
        if role == "assistant" and CHAT_CTX_PRUNE_AFTER_ASSISTANT:
            asyncio.create_task(_prune_chat_ctx())

    await session.start(
        agent=agent,
        room=ctx.room,
        room_options=room_io.RoomOptions(close_on_disconnect=True),
    )

    handle = await session.generate_reply(
        instructions=VOICE_AGENT_GREETING_INSTRUCTIONS,
    )
    await handle.wait_for_playout()

    await session_closed.wait()
    try:
        usage_summary = usage_collector.get_summary()
        log_usage_summary_and_cost(
            logger=logger,
            usage_summary=usage_summary,
            model_name=MODEL_NAME,
            include_usage_summary=LOG_TOKEN_USAGE,
            include_cost_estimate=LOG_COST_ESTIMATE,
        )
    except Exception:
        logger.exception("token_usage_summary_failed")


if __name__ == "__main__":
    cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint))
