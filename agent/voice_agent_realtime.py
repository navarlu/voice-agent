import json
import os
import time
from pathlib import Path
import sys

from dotenv import load_dotenv
from livekit.agents import (
    Agent,
    AgentSession,
    AutoSubscribe,
    JobContext,
    WorkerOptions,
    cli,
    function_tool,
    llm,
    RunContext,
)
from livekit.plugins import openai


BASE_DIR = Path(__file__).resolve().parent.parent
TRANSCRIPT_STORE = BASE_DIR / "local" / "session_transcripts.json"
SRC_DIR = BASE_DIR / "src"

if str(SRC_DIR) not in sys.path:
    sys.path.append(str(SRC_DIR))

import weaviate_utils  
from config import (  
    GREETING_INSTRUCTIONS,
    GREETING_USER_INPUT,
    MODEL_NAME,
    SYSTEM_PROMPT,
)

load_dotenv(BASE_DIR / ".env")

FALLBACK_TTS = False


def _load_store() -> dict:
    if not TRANSCRIPT_STORE.exists():
        return {"users": {}}
    try:
        with TRANSCRIPT_STORE.open("r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (json.JSONDecodeError, OSError):
        return {"users": {}}
    if not isinstance(data, dict):
        return {"users": {}}
    data.setdefault("users", {})
    return data


def _save_store(data: dict) -> None:
    TRANSCRIPT_STORE.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = TRANSCRIPT_STORE.with_suffix(".json.tmp")
    with tmp_path.open("w", encoding="utf-8") as handle:
        json.dump(data, handle, indent=2, ensure_ascii=True)
    tmp_path.replace(TRANSCRIPT_STORE)


async def entrypoint(ctx: JobContext):
    await ctx.connect(auto_subscribe=AutoSubscribe.SUBSCRIBE_ALL)

    # Wait until a participant joins before speaking.
    participant = await ctx.wait_for_participant()
    user_name = (participant.name or "").strip() or "Guest"
    collection_name = weaviate_utils.normalize_collection_name(user_name)

    weaviate_ready = weaviate_utils.wait_for_weaviate(debug=True)
    if not weaviate_ready:
        print("[weaviate] not ready within timeout")
    with weaviate_utils.connect_client() as client:
        weaviate_utils.ensure_collection(client, collection_name)
    print(f"[weaviate] using collection: {collection_name} for user: {user_name}")

    store = _load_store()
    user_record = store.setdefault("users", {}).setdefault(user_name, {"sessions": []})
    previous_session = user_record["sessions"][-1] if user_record["sessions"] else None
    previous_items = previous_session.get("items", []) if previous_session else []

    chat_ctx = llm.ChatContext.empty()
    chat_ctx.add_message(role="system", content=f"The user's name is {user_name}.")
    for item in previous_items:
        role = item.get("role")
        content = item.get("content")
        created_at = item.get("created_at")
        if role in ("user", "assistant") and isinstance(content, str) and content.strip():
            if isinstance(created_at, (int, float)):
                chat_ctx.add_message(role=role, content=content, created_at=created_at)
            else:
                chat_ctx.add_message(role=role, content=content)

    @function_tool
    async def query_search(context: RunContext, query: str, limit: int = 5):
        """MANDATORY FIRST STEP. Search the user's private knowledge base."""
        print(f"[search] query={query!r} limit={limit} collection={collection_name}")
        payload = json.dumps({"state": "start", "query": query}, ensure_ascii=False)
        await ctx.room.local_participant.publish_data(payload, topic="search_status")
        try:
            results = weaviate_utils.search_txt(
                query=query,
                limit=limit,
                collection_name=collection_name,
            )
            print(f"[search] results={len(results)}")
            return json.dumps({"results": results}, ensure_ascii=False)
        finally:
            payload = json.dumps({"state": "end"}, ensure_ascii=False)
            await ctx.room.local_participant.publish_data(payload, topic="search_status")

    agent = Agent(
        instructions=SYSTEM_PROMPT,
        tools=[query_search],
        chat_ctx=chat_ctx,
    )

    session_record = {
        "room": getattr(ctx.room, "name", ""),
        "started_at": time.time(),
        "ended_at": None,
        "items": [],
    }
    user_record["sessions"].append(session_record)
    _save_store(store)

    session_kwargs = {
        "llm": openai.realtime.RealtimeModel(
            model=MODEL_NAME,
            voice="Marin",
            api_key=os.getenv("OPENAI_API_KEY"),
        ),
    }
    if FALLBACK_TTS:
        session_kwargs["tts"] = openai.TTS(model="gpt-4o-mini-tts", voice="Marin")
    session = AgentSession(**session_kwargs)

    def handle_conversation_item(event) -> None:
        message = getattr(event, "item", None)
        if not message or getattr(message, "type", None) != "message":
            return
        if message.role not in ("user", "assistant"):
            return
        text = message.text_content
        if not text or not text.strip():
            return
        session_record["items"].append(
            {
                "role": message.role,
                "content": text,
                "created_at": message.created_at,
            }
        )
        _save_store(store)

    def handle_close(event) -> None:
        session_record["ended_at"] = time.time()
        _save_store(store)

    session.on("conversation_item_added", handle_conversation_item)
    session.on("close", handle_close)

    await session.start(agent=agent, room=ctx.room)

    # Optional: greet after the participant is present.
    handle = await session.generate_reply(
        user_input=GREETING_USER_INPUT,
        instructions=GREETING_INSTRUCTIONS,
    )
    await handle.wait_for_playout()


if __name__ == "__main__":
    cli.run_app(
        WorkerOptions(
            entrypoint_fnc=entrypoint,
        )
    )
