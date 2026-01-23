import os
import uuid
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from livekit.api import AccessToken, VideoGrants


# Always load env from repo root so running from token_server/ still works
load_dotenv(Path(__file__).resolve().parent.parent / ".env")

LIVEKIT_API_KEY = os.getenv("LIVEKIT_API_KEY", "").strip()
LIVEKIT_API_SECRET = os.getenv("LIVEKIT_API_SECRET", "").strip()
LIVEKIT_URL = os.getenv("LIVEKIT_URL", "").strip()
DEMO_PASSCODE = os.getenv("DEMO_PASSCODE", "").strip()
ALLOWED_ORIGINS = [
    origin.strip()
    for origin in os.getenv("ALLOWED_ORIGINS", "").split(",")
    if origin.strip()
]
ROOM_PREFIX = os.getenv("ROOM_PREFIX", "robbie")


def _mask(value: str) -> str:
    if not value:
        return ""
    if len(value) <= 4:
        return "*" * len(value)
    return f"{value[:2]}***{value[-2:]}"


class TokenRequest(BaseModel):
    name: str
    passcode: str


class TokenResponse(BaseModel):
    token: str
    room: str
    url: str


app = FastAPI()

if ALLOWED_ORIGINS:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=ALLOWED_ORIGINS,
        allow_credentials=False,
        allow_methods=["POST"],
        allow_headers=["*"],
    )

print(
    "[token_service] config",
    {
        "LIVEKIT_URL": LIVEKIT_URL,
        "LIVEKIT_API_KEY": _mask(LIVEKIT_API_KEY),
        "LIVEKIT_API_SECRET": _mask(LIVEKIT_API_SECRET),
        "DEMO_PASSCODE_SET": bool(DEMO_PASSCODE),
        "ALLOWED_ORIGINS": ALLOWED_ORIGINS,
        "ROOM_PREFIX": ROOM_PREFIX,
    },
)


def _require_env():
    if not LIVEKIT_API_KEY or not LIVEKIT_API_SECRET or not LIVEKIT_URL:
        raise HTTPException(status_code=500, detail="Server not configured")
    if not DEMO_PASSCODE:
        raise HTTPException(status_code=500, detail="Passcode not configured")


@app.post("/token", response_model=TokenResponse)
def mint_token(payload: TokenRequest) -> TokenResponse:
    _require_env()
    if payload.passcode != DEMO_PASSCODE:
        raise HTTPException(status_code=401, detail="Invalid passcode")

    room_name = f"{ROOM_PREFIX}-{uuid.uuid4().hex[:8]}"
    identity = f"web-{uuid.uuid4().hex}"

    try:
        token = (
            AccessToken(api_key=LIVEKIT_API_KEY, api_secret=LIVEKIT_API_SECRET)
            .with_identity(identity)
            .with_name(payload.name.strip() or "Guest")
            .with_grants(
                VideoGrants(
                    room=room_name,
                    room_join=True,
                    can_publish=True,
                    can_subscribe=True,
                )
            )
        )
        jwt = token.to_jwt()
    except Exception as exc:
        print("[token_service] token generation failed:", repr(exc))
        raise

    print(
        "[token_service] issued token",
        {"room": room_name, "identity": identity, "name": payload.name.strip()},
    )

    return TokenResponse(token=jwt, room=room_name, url=LIVEKIT_URL)
