import os
import uuid
from typing import List

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from livekit.api import AccessToken, VideoGrants


load_dotenv()

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
        allow_headers=["*"]
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

    token = AccessToken(
        api_key=LIVEKIT_API_KEY,
        api_secret=LIVEKIT_API_SECRET,
        identity=identity,
        name=payload.name.strip() or "Guest",
    )
    token.add_grant(
        VideoGrants(
            room=room_name,
            room_join=True,
            can_publish=True,
            can_subscribe=True,
        )
    )

    return TokenResponse(token=token.to_jwt(), room=room_name, url=LIVEKIT_URL)
