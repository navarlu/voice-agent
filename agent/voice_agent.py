import os
from pathlib import Path

from dotenv import load_dotenv
from livekit.agents import (
    Agent,
    AgentSession,
    AutoSubscribe,
    JobContext,
    WorkerOptions,
    cli,
    function_tool,
    RunContext,
)
from livekit.plugins import openai, silero


BASE_DIR = Path(__file__).resolve().parent.parent

load_dotenv(BASE_DIR / ".env")


@function_tool
async def lookup_weather(context: RunContext, location: str):
    """Used to look up weather information."""
    return {"weather": "sunny", "temperature": 70}


LLM = openai.LLM(
    model="gpt-4o-mini",
    api_key=os.getenv("OPENAI_API_KEY"),
)


async def entrypoint(ctx: JobContext):
    await ctx.connect(auto_subscribe=AutoSubscribe.SUBSCRIBE_ALL)

    # Wait until a participant joins before speaking.
    await ctx.wait_for_participant()

    agent = Agent(
        instructions="You are a friendly Czech voice assistant. Your name is Pepper.",
        tools=[lookup_weather],
    )

    session = AgentSession(
        vad=silero.VAD.load(),
        stt=openai.STT(model="gpt-4o-transcribe", language="cs"),
        llm=LLM,
        tts=openai.TTS(model="gpt-4o-mini-tts", voice="alloy"),
    )

    await session.start(agent=agent, room=ctx.room)

    # Optional: greet after the participant is present.
    handle = await session.generate_reply(
        user_input="Ahoj!",
        instructions="Pozdrav uzivatele a zeptej se, jak se ma.",
    )
    await handle.wait_for_playout()


if __name__ == "__main__":
    cli.run_app(
        WorkerOptions(
            entrypoint_fnc=entrypoint,
        )
    )
