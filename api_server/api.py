import os
import sys
import uuid
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from livekit.api import AccessToken, VideoGrants


# Always load env from repo root so running from api_server/ still works
BASE_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BASE_DIR / ".env")

SRC_DIR = BASE_DIR / "src"
if str(SRC_DIR) not in sys.path:
    sys.path.append(str(SRC_DIR))
AGENT_DIR = BASE_DIR / "agent"
if str(AGENT_DIR) not in sys.path:
    sys.path.append(str(AGENT_DIR))

import pdf_ingest  
import weaviate_utils  
try: 
    from voice_agent_realtime import MODEL_NAME as AGENT_MODEL_NAME  # type: ignore
except Exception:
    AGENT_MODEL_NAME = "unknown"

LIVEKIT_API_KEY = os.getenv("LIVEKIT_API_KEY", "").strip()
LIVEKIT_API_SECRET = os.getenv("LIVEKIT_API_SECRET", "").strip()
LIVEKIT_URL = os.getenv("LIVEKIT_URL", "").strip()
DEMO_PASSCODE = os.getenv("DEMO_PASSCODE", "").strip()
ALLOWED_ORIGINS = [
    origin.strip()
    for origin in os.getenv("ALLOWED_ORIGINS", "").split(",")
    if origin.strip()
]
ROOM_PREFIX = os.getenv("ROOM_PREFIX", "realtime-demo")
UPLOADS_DIR = BASE_DIR / "local" / "uploads"


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


class DeleteDocumentRequest(BaseModel):
    name: str
    source: str
    passcode: str | None = None


class ListDocumentsRequest(BaseModel):
    name: str
    passcode: str | None = None


app = FastAPI()

if ALLOWED_ORIGINS:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=ALLOWED_ORIGINS,
        allow_credentials=False,
        allow_methods=["POST", "GET", "OPTIONS"],
        allow_headers=["*"],
    )

print(
    "[api] config",
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


def _verify_passcode(passcode: str | None) -> None:
    if DEMO_PASSCODE and passcode != DEMO_PASSCODE:
        raise HTTPException(status_code=401, detail="Invalid passcode")


def _safe_filename(name: str) -> str:
    base = Path(name).name
    if not base:
        return "document.pdf"
    cleaned = "".join(ch if ch.isalnum() or ch in {"-", "_", "."} else "_" for ch in base)
    return cleaned or "document.pdf"


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
        print("[api] token generation failed:", repr(exc))
        raise

    print(
        "[api] issued token",
        {"room": room_name, "identity": identity, "name": payload.name.strip()},
    )

    return TokenResponse(token=jwt, room=room_name, url=LIVEKIT_URL)


@app.get("/session/meta")
def session_meta():
    return {"model_name": AGENT_MODEL_NAME}


@app.post("/documents/upload")
async def upload_document(
    name: str = Form(...),
    file: UploadFile = File(...),
    passcode: str | None = Form(None),
):
    _verify_passcode(passcode)
    if not file.filename:
        raise HTTPException(status_code=400, detail="Missing filename")
    if not file.filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Only PDF files are supported")

    user_name = name.strip() or "Guest"
    collection_name = weaviate_utils.normalize_collection_name(user_name)
    target_dir = UPLOADS_DIR / collection_name
    target_dir.mkdir(parents=True, exist_ok=True)

    filename = _safe_filename(file.filename)
    file_path = target_dir / filename
    contents = await file.read()
    file_path.write_bytes(contents)

    if not weaviate_utils.wait_for_weaviate(max_wait_s=20, interval_s=1.5, debug=True):
        raise HTTPException(status_code=503, detail="Weaviate is unavailable")

    with weaviate_utils.connect_client() as client:
        weaviate_utils.ensure_collection(client, collection_name)

    result = pdf_ingest.ingest_pdf_file(file_path, collection_name=collection_name)
    print(
        "[documents] ingested",
        {
            "user": user_name,
            "collection": collection_name,
            "file": filename,
            "chunks": result["chunks"],
            "pages": result["pages"],
        },
    )
    return {
        "status": "ok",
        "file_name": filename,
        "collection": collection_name,
        "source": result["source_base"],
        "chunks": result["chunks"],
        "pages": result["pages"],
    }


@app.post("/documents/delete")
def delete_document(payload: DeleteDocumentRequest):
    _verify_passcode(payload.passcode)
    user_name = payload.name.strip() or "Guest"
    collection_name = weaviate_utils.normalize_collection_name(user_name)
    deleted = weaviate_utils.delete_source(payload.source, collection_name=collection_name)
    return {"status": "ok", "deleted": deleted}


@app.post("/documents/list")
def list_documents(payload: ListDocumentsRequest):
    _verify_passcode(payload.passcode)
    user_name = payload.name.strip() or "Guest"
    collection_name = weaviate_utils.normalize_collection_name(user_name)
    sources = weaviate_utils.list_sources(collection_name=collection_name)
    items = []
    for entry in sources:
        source = entry.get("source", "")
        base = source.split("#", 1)[0] if source else ""
        name = Path(base).name if base else "document.pdf"
        size = 0
        if base and Path(base).exists():
            try:
                size = Path(base).stat().st_size
            except OSError:
                size = 0
        items.append(
            {
                "source": base,
                "name": name,
                "size": size,
                "chunks": entry.get("count", 0),
            }
        )
    return {"status": "ok", "documents": items}
