# Robbie Voice Agent Demo

Static GitHub Pages UI + FastAPI token server for a LiveKit voice agent. The agent code now lives separately from the token server so you can run/deploy them independently.

## Architecture

- `web/` → GitHub Pages static UI (WebRTC via LiveKit JS)
- `token_server/` → FastAPI service that mints LiveKit tokens
- `agent/` → LiveKit agent process (LLM/STT/TTS)
- LiveKit server → public URL with TLS (HTTPS/WSS)
- RPi agent connects to LiveKit over Tailscale

## Setup

### 1) LiveKit URL + TLS

Browsers require HTTPS/WSS for mic access. Point a subdomain like `livekit.virtualemployees.solutions` to your VM and terminate TLS (Caddy/NGINX). The web client uses:

```
wss://livekit.virtualemployees.solutions
```

### 2) Shared env file

Create a single `.env` in the repo root (next to this README). Both the token server and the agent read from it:

```
LIVEKIT_URL=wss://livekit.virtualemployees.solutions
LIVEKIT_API_KEY=...
LIVEKIT_API_SECRET=...
DEMO_PASSCODE=...
ALLOWED_ORIGINS=https://<your-github-pages-domain>
ROOM_PREFIX=robbie
OPENAI_API_KEY=...
```

### 3) Python env + deps (single venv, single requirements)

Keep one virtualenv at repo root (ignored by git) and install a single shared requirements file:

```
uv venv
source .venv/bin/activate
uv pip install -r requirements.txt
```

### 4) Run token server

```
uv run uvicorn token_server.main:app --host 0.0.0.0 --port 8000
```

If your reverse proxy routes `/api/` to this server, map `/api/token` → `/token`.

### 5) Run the voice agent

In another shell (same virtualenv):

```
uv run python agent/voice_agent.py
```

The agent will join LiveKit and greet the first participant.

### 6) GitHub Pages UI

Update `web/app.js`:

```
const TOKEN_ENDPOINT = "https://livekit.virtualemployees.solutions/api/token";
```

Publish the `web/` folder with GitHub Pages.

## Notes

- CORS only blocks browsers; still require a passcode.
- For tighter control, rotate passcodes or add one-time tokens.
- This demo is WebRTC-only. SIP is for phone dialing and doesn’t apply to GitHub Pages.
