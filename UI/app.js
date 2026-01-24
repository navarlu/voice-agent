import React, { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import htm from "htm";
import {
  LiveKitRoom,
  RoomAudioRenderer,
  ConnectionStateToast,
  StartAudio,
  TrackToggle,
  useConnectionState,
  useLocalParticipant,
  useRoomContext,
  useTracks,
  useVoiceAssistant,
  useTranscriptions,
  VideoTrack,
  BarVisualizer,
} from "@livekit/components-react";
import { Track } from "livekit-client";

const html = htm.bind(React.createElement);

const PROD_TOKEN_ENDPOINT = "https://livekit.virtualemployees.solutions/api/token";
const LOCAL_TOKEN_ENDPOINT = "http://localhost:8001/token";
const ENV_STORAGE_KEY = "lk-env";

const CHAT_TOPIC = "lk.chat";

function resolveEnvironment() {
  const params = new URLSearchParams(window.location.search);
  const paramEnv = params.get("env");
  if (paramEnv) {
    localStorage.setItem(ENV_STORAGE_KEY, paramEnv);
  }

  const storedEnv = localStorage.getItem(ENV_STORAGE_KEY);
  const isLocalHost = ["localhost", "127.0.0.1"].includes(window.location.hostname);
  const env = paramEnv || storedEnv || (isLocalHost ? "local" : "prod");

  return env === "local" ? "local" : "prod";
}

function getTokenEndpoint(activeEnv) {
  return activeEnv === "local" ? LOCAL_TOKEN_ENDPOINT : PROD_TOKEN_ENDPOINT;
}

async function fetchToken(activeEnv, name, passcode) {
  const response = await fetch(getTokenEndpoint(activeEnv), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, passcode }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.detail || "Failed to fetch token");
  }

  return response.json();
}

function WelcomeView({ status, onStart, activeEnv, onToggleEnv, name, passcode, onName, onPasscode }) {
  return html`<div className="welcome">
    <div className="welcome__card">
      <button type="button" className="env env--welcome" onClick=${onToggleEnv}>
        <span className="env__dot"></span>
        ${activeEnv}
      </button>
      <div className="welcome__icon" aria-hidden="true">
        <span></span>
        <span></span>
        <span></span>
        <span></span>
      </div>
      <p className="welcome__title">Demo voice agent</p>
      <h1>Talk to Pepper</h1>
      <p className="welcome__subtitle">
        Enter your details to request a LiveKit token and start the session.
      </p>
      <form className="welcome__form" onSubmit=${onStart}>
        <label>
          Name
          <input
            type="text"
            placeholder="Your name"
            value=${name}
            onInput=${(event) => onName(event.target.value)}
            required
          />
        </label>
        <label>
          Passcode
          <input
            type="password"
            placeholder="Shared passcode"
            value=${passcode}
            onInput=${(event) => onPasscode(event.target.value)}
            required
          />
        </label>
        <button className="welcome__cta" type="submit">Start call</button>
      </form>
      <p className="welcome__status">${status}</p>
    </div>
    <p className="welcome__footer">
      
    </p>
  </div>`;
}

function ConnectionPill() {
  const connectionState = useConnectionState();
  const state = connectionState || "disconnected";
  const label =
    state === "connected"
      ? "Connected"
      : state === "connecting"
      ? "Connecting"
      : state === "reconnecting"
      ? "Reconnecting"
      : "Disconnected";

  return html`<span className=${"pill pill--" + state}>${label}</span>`;
}

function TranscriptPanel() {
  const transcriptions = useTranscriptions();
  const { localParticipant } = useLocalParticipant();

  const rows = useMemo(() => {
    return transcriptions.map((item, index) => {
      const identity =
        item.participantInfo?.identity || item.streamInfo?.participantIdentity || "unknown";
      return {
        id: `transcript-${identity}-${index}`,
        author: identity === localParticipant?.identity ? "You" : "Agent",
        text: item.text,
      };
    });
  }, [transcriptions, localParticipant]);

  return html`<section className="panel panel--messages">
    <header className="panel__header">
      <h3>Transcript</h3>
      <span>${rows.length}</span>
    </header>
    <div className="panel__body panel__body--messages">
      ${rows.length === 0
        ? html`<p className="panel__empty">Start speaking to see live transcription.</p>`
        : rows.map(
            (row) => html`<div className="message-item" key=${row.id}>
              <span className="message-item__label">${row.author}</span>
              <p>${row.text}</p>
            </div>`
          )}
    </div>
  </section>`;
}

function AgentCanvas() {
  const { state, audioTrack, videoTrack } = useVoiceAssistant();
  const { localParticipant } = useLocalParticipant();
  const cameraPub = localParticipant?.getTrackPublication(Track.Source.Camera);
  const cameraTrack =
    cameraPub && !cameraPub.isMuted
      ? { participant: localParticipant, source: Track.Source.Camera, publication: cameraPub }
      : undefined;
  const [screenShareTrack] = useTracks([Track.Source.ScreenShare]);

  const style = "pill";
  const barCount = 7;

  return html`<div className="agent-canvas">
    <div className="agent-canvas__core">
      ${videoTrack
        ? html`<${VideoTrack} trackRef=${videoTrack} className="agent-canvas__video" />`
        : html`<${BarVisualizer}
            state=${state}
            track=${audioTrack}
            barCount=${barCount}
            className=${"agent-visualizer agent-visualizer--" + style}
          >
            <span className="agent-visualizer__bar"></span>
          </${BarVisualizer}>`}
    </div>
    <div className="agent-state">
      <span className="agent-state__label">Pepper</span>
      <span className=${"agent-state__pill agent-state__pill--" + state}>
        ${state || "idle"}
      </span>
    </div>
    <div className="agent-canvas__tiles">
      ${cameraTrack
        ? html`<div className="agent-tile">
            <${VideoTrack} trackRef=${cameraTrack} className="agent-tile__video" />
          </div>`
        : null}
      ${screenShareTrack
        ? html`<div className="agent-tile">
            <${VideoTrack} trackRef=${screenShareTrack} className="agent-tile__video" />
          </div>`
        : null}
    </div>
  </div>`;
}

function SessionView({ roomName, displayName, onHangup }) {
  const room = useRoomContext();
  const { localParticipant } = useLocalParticipant();
  const identity = displayName || localParticipant?.identity || "you";

  return html`<section className="session-shell">
    <${ConnectionStateToast} />
    <${RoomAudioRenderer} />

    <header className="session-shell__top">
      <div className="session-shell__summary">
        <span className="meta meta--quiet">Session</span>
        <h2>${roomName || "-"}</h2>
        <span className="session-shell__identity">${identity}</span>
      </div>
      <${ConnectionPill} />
    </header>

    <div className="session-shell__main">
      <div className="session-shell__canvas">
        <div className="session-shell__canvas-header">
          <span className="meta">Agent canvas</span>
          <span className="pill pill--connected">Live</span>
        </div>
        <${AgentCanvas} />
        <div className="canvas-controls">
          <${StartAudio} label="Enable audio" className="lk-start-audio" />
          <${TrackToggle}
            source=${Track.Source.Microphone}
            showIcon=${true}
            className="control-bar__button"
          />
          <button
            type="button"
            className="control-bar__button control-bar__button--danger"
            onClick=${() => {
              room?.disconnect();
              onHangup?.();
            }}
          >
            Hang up
          </button>
        </div>
      </div>

      <aside className="session-shell__side">
        <div className="session-shell__panel">
          <${TranscriptPanel} />
        </div>
      </aside>
    </div>

  </section>`;
}

function App() {
  const [activeEnv, setActiveEnv] = useState(resolveEnvironment());
  const [name, setName] = useState("");
  const [passcode, setPasscode] = useState("");
  const [status, setStatus] = useState("Ready when you are.");
  const [token, setToken] = useState(undefined);
  const [serverUrl, setServerUrl] = useState(undefined);
  const [roomName, setRoomName] = useState("-");
  const [displayName, setDisplayName] = useState("");
  const [shouldConnect, setShouldConnect] = useState(false);

  const toggleEnv = () => {
    const nextEnv = activeEnv === "local" ? "prod" : "local";
    setActiveEnv(nextEnv);
    localStorage.setItem(ENV_STORAGE_KEY, nextEnv);
  };

  const startSession = async (event) => {
    event?.preventDefault();
    if (!name.trim() || !passcode.trim()) {
      setStatus("Add name and passcode to start.");
      return;
    }

    setStatus("Requesting token...");
    try {
      const response = await fetchToken(activeEnv, name.trim(), passcode.trim());
      setToken(response.token);
      setServerUrl(response.url);
      setRoomName(response.room);
      setDisplayName(name.trim());
      setShouldConnect(true);
      setStatus("Connecting to LiveKit...");
    } catch (error) {
      setStatus(error?.message || "Failed to connect.");
      setShouldConnect(false);
    }
  };

  const handleDisconnected = () => {
    setStatus("Disconnected.");
    setShouldConnect(false);
    setToken(undefined);
    setServerUrl(undefined);
    setRoomName("-");
  };

  return html`<div className="page">
    ${token
      ? html`<${LiveKitRoom}
          token=${token}
          serverUrl=${serverUrl}
          connect=${shouldConnect}
          audio=${{ echoCancellation: true, noiseSuppression: true, autoGainControl: true }}
          video=${false}
          onConnected=${() => setStatus("Connected. Speak to Pepper!")}
          onDisconnected=${handleDisconnected}
          onError=${(error) => setStatus(error?.message || "LiveKit error.")}
          data-lk-theme="default"
        >
              <${SessionView}
                roomName=${roomName}
                displayName=${displayName}
                onHangup=${handleDisconnected}
              />
            </${LiveKitRoom}>`
      : html`<${WelcomeView}
          status=${status}
          onStart=${startSession}
          activeEnv=${activeEnv}
          onToggleEnv=${toggleEnv}
          name=${name}
          passcode=${passcode}
          onName=${setName}
          onPasscode=${setPasscode}
        />`}
  </div>`;
}

const root = createRoot(document.getElementById("app"));
root.render(html`<${App} />`);
