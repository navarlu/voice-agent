# Robbie Voice Agent Demo

Static GitHub Pages UI + FastAPI token server for a LiveKit voice agent.

## Architecture

- `web/` → GitHub Pages static UI (WebRTC via LiveKit JS)
- `token_server/` → FastAPI service that mints LiveKit tokens
- LiveKit server → public URL with TLS (HTTPS/WSS)
- RPi agent connects to LiveKit over Tailscale

## Setup

### 1) LiveKit URL + TLS

Browsers require HTTPS/WSS for mic access. Point a subdomain like `livekit.virtualemployees.solutions` to your VM and terminate TLS (Caddy/NGINX). The web client uses:

```
wss://livekit.virtualemployees.solutions
```

### 2) Token server env

Create `.env` in `token_server/`:

```
LIVEKIT_URL=wss://livekit.virtualemployees.solutions
LIVEKIT_API_KEY=...
LIVEKIT_API_SECRET=...
DEMO_PASSCODE=...
ALLOWED_ORIGINS=https://<your-github-pages-domain>
ROOM_PREFIX=robbie
```

### 3) Run token server

```
uv venv
uv pip install -r token_server/requirements.txt
uv run uvicorn token_server.main:app --host 0.0.0.0 --port 8000
```

If your reverse proxy routes `/api/` to this server, map `/api/token` → `/token`.

### 4) GitHub Pages UI

Update `web/app.js`:

```
const TOKEN_ENDPOINT = "https://livekit.virtualemployees.solutions/api/token";
```

Publish the `web/` folder with GitHub Pages.

## Notes

- CORS only blocks browsers; still require a passcode.
- For tighter control, rotate passcodes or add one-time tokens.
- This demo is WebRTC-only. SIP is for phone dialing and doesn’t apply to GitHub Pages.
