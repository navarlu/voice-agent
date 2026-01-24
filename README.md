# Robbie Voice Agent Demo

Showcase of a LiveKit voice agent with a function tool that searches a vector database (RAG). Users can try it on GitHub Pages after entering the passcode at:

```
https://navarlu.github.io/voice-agent/
```

Static GitHub Pages UI + FastAPI token server for a LiveKit voice agent. The agent code now lives separately from the token server so you can run/deploy them independently.

## Architecture

- `docs/` → GitHub Pages static UI (WebRTC via LiveKit JS)
- `token_server/` → FastAPI service that mints LiveKit tokens
- `agent/` → LiveKit agent process (LLM/STT/TTS)
- LiveKit server → public URL with TLS (HTTPS/WSS)
- RPi agent connects to LiveKit over Tailscale

## Setup

### 0) Local LiveKit (Docker)

For local dev, spin up LiveKit + Redis:

```
docker compose \
  --env-file .env \
  -f local/docker-compose.yml up -d
```

Update your `.env` for local:

```
LIVEKIT_URL=ws://localhost:7880
LIVEKIT_API_KEY=LK_LOCAL_KEY
LIVEKIT_API_SECRET=LK_LOCAL_SECRET
ALLOWED_ORIGINS=http://localhost:5500
```

`local/livekit.yaml` contains the matching key/secret. Change both if you prefer your own values.

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
uv pip install -r requirements.txt
```

### 4) Run token server

```
uv run uvicorn token_server.token_service:app --host 0.0.0.0 --port 8001
```

If your reverse proxy routes `/api/` to this server, map `/api/token` → `/token`.

### 5) Run the voice agent

In another shell (same virtualenv):

```
uv run python agent/voice_agent.py
```

The agent will join LiveKit and greet the first participant.

### 6) GitHub Pages UI

Update `docs/app.js`:

```
const TOKEN_ENDPOINT = "https://livekit.virtualemployees.solutions/api/token";
```

Publish the `docs/` folder with GitHub Pages.

### 7) Run local static UI server

Serve the static UI locally:

```
uv run python -m http.server 5500 --directory docs
```

### Local UI toggle

The UI now auto-switches to local endpoints on `localhost`. You can also force it:

- `?env=local` → uses `http://localhost:8001/token`
- `?env=prod` → uses production URL

The selection is persisted in localStorage.

