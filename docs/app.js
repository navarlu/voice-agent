import React, { useEffect, useMemo, useState } from "react";
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
import { Track, RoomEvent } from "livekit-client";

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

function getApiBase(activeEnv) {
  return getTokenEndpoint(activeEnv).replace(/\/token$/, "");
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

async function uploadDocument(activeEnv, name, passcode, file) {
  const formData = new FormData();
  formData.append("name", name);
  formData.append("file", file);
  if (passcode) {
    formData.append("passcode", passcode);
  }

  const response = await fetch(`${getApiBase(activeEnv)}/documents/upload`, {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.detail || "Failed to upload document");
  }

  return response.json();
}

async function deleteDocument(activeEnv, name, passcode, source) {
  const response = await fetch(`${getApiBase(activeEnv)}/documents/delete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, passcode, source }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.detail || "Failed to delete document");
  }

  return response.json();
}

async function listDocuments(activeEnv, name, passcode) {
  const response = await fetch(`${getApiBase(activeEnv)}/documents/list`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, passcode }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.detail || "Failed to fetch documents");
  }

  return response.json();
}

async function fetchSessionMeta(activeEnv) {
  const response = await fetch(`${getApiBase(activeEnv)}/session/meta`, {
    method: "GET",
  });

  if (!response.ok) {
    throw new Error("Failed to fetch session metadata");
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
        about your day or the documents you upload
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

function SessionMetaCard({ roomName, identity, modelName }) {
  return html`<section className="panel meta-card">
    <header className="meta-card__header panel__header">
      <span className="meta meta--quiet">Session</span>
      <${ConnectionPill} />
    </header>
    <div className="meta-card__body">
      <div className="meta-row">
        <span className="meta-label">Identity</span>
        <span className="meta-value">${identity || "-"}</span>
      </div>
      <div className="meta-row">
        <span className="meta-label">Room</span>
        <span className="meta-value">${roomName || "-"}</span>
      </div>
      <div className="meta-row">
        <span className="meta-label">Model</span>
        <span className="meta-value">${modelName || "-"}</span>
      </div>
    </div>
  </section>`;
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

function formatFileSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function FileUploadPanel({ files, onAddFiles, onRemoveFile }) {
  const [dragging, setDragging] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const room = useRoomContext();

  useEffect(() => {
    if (!room) {
      return undefined;
    }
    const handleData = (payload, participant, kind, topic) => {
      if (topic !== "search_status") {
        return;
      }
      const text = new TextDecoder().decode(payload);
      try {
        const message = JSON.parse(text);
        if (message.state === "start") {
          setIsSearching(true);
        }
        if (message.state === "end") {
          setIsSearching(false);
        }
      } catch (error) {
        // ignore malformed payloads
      }
    };
    room.on(RoomEvent.DataReceived, handleData);
    return () => {
      room.off(RoomEvent.DataReceived, handleData);
    };
  }, [room]);

  return html`<section
    className=${"panel panel--files" + (isSearching ? " panel--searching" : "")}
  >
    <header className="panel__header">
      <span className="meta">Documents</span>
      <span>${files.length}</span>
    </header>
    <div className="panel__body">
      <label
        className=${"upload-card" + (dragging ? " upload-card--drag" : "")}
        onDragOver=${(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave=${() => setDragging(false)}
        onDrop=${(event) => {
          event.preventDefault();
          setDragging(false);
          onAddFiles(event.dataTransfer.files);
        }}
      >
        <input
          type="file"
          accept="application/pdf"
          multiple
          onChange=${(event) => {
            onAddFiles(event.target.files);
            event.target.value = "";
          }}
        />
        <span className="upload-card__title">Upload PDFs</span>
        <span className="upload-card__meta">Drop or select files</span>
      </label>
      ${files.length === 0
        ? html`<p className="panel__empty">No PDFs uploaded yet.</p>`
        : html`<div className="file-scroll">
            <div className="file-list">
              ${files.map(
                (file) => html`<div className="file-item" key=${file.id}>
                  <div className="file-meta">
                    <span className="file-name">${file.name}</span>
                    <span className="file-size">${formatFileSize(file.size)}</span>
                  </div>
                  <span className=${"file-status file-status--" + file.status}>
                    ${file.status === "ready"
                      ? "Ready"
                      : file.status === "error"
                      ? "Failed"
                      : "Preparing"}
                  </span>
                  <button
                    type="button"
                    className="file-remove"
                    onClick=${() => onRemoveFile(file.id)}
                  >
                    Remove
                  </button>
                </div>`
              )}
            </div>
          </div>`}
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

function SessionView({
  roomName,
  displayName,
  modelName,
  onHangup,
  files,
  onAddFiles,
  onRemoveFile,
}) {
  const room = useRoomContext();
  const { localParticipant } = useLocalParticipant();
  const identity = displayName || localParticipant?.identity || "you";

  return html`<section className="session-shell">
    <${ConnectionStateToast} />
    <${RoomAudioRenderer} />

    <div className="session-shell__main">
      <div className="session-shell__canvas">
        <div className="session-shell__canvas-header panel__header">
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
        <${SessionMetaCard}
          roomName=${roomName}
          identity=${identity}
          modelName=${modelName}
        />
        <${FileUploadPanel}
          files=${files}
          onAddFiles=${onAddFiles}
          onRemoveFile=${onRemoveFile}
        />
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
  const [modelName, setModelName] = useState("-");
  const [shouldConnect, setShouldConnect] = useState(false);
  const [files, setFiles] = useState([]);
  const [docsLoaded, setDocsLoaded] = useState(false);

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
    setFiles([]);
    setDocsLoaded(false);
    setModelName("-");
  };

  const loadDocuments = async (userName) => {
    if (docsLoaded) {
      return;
    }
    try {
      const response = await listDocuments(activeEnv, userName, passcode);
      const documents = response.documents || [];
      setFiles(
        documents.map((doc) => ({
          id: `${doc.source}-${Math.random().toString(16).slice(2)}`,
          name: doc.name,
          size: doc.size || 0,
          status: "ready",
          source: doc.source,
        }))
      );
      setDocsLoaded(true);
    } catch (error) {
      // ignore initial load errors
    }
  };

  const handleAddFiles = async (fileList) => {
    if (!fileList?.length) {
      return;
    }
    const userName = displayName || name || "Guest";
    const nextFiles = Array.from(fileList)
      .filter((file) => file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf"))
      .map((file) => ({
        id: `${file.name}-${file.size}-${file.lastModified}-${Math.random().toString(16).slice(2)}`,
        name: file.name,
        size: file.size,
        status: "processing",
        source: "",
      }));
    if (nextFiles.length === 0) {
      return;
    }
    setFiles((prev) => [...prev, ...nextFiles]);
    const filesArray = Array.from(fileList).filter(
      (file) => file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")
    );
    await Promise.all(
      nextFiles.map(async (entry, index) => {
        const file = filesArray[index];
        try {
          const response = await uploadDocument(activeEnv, userName, passcode, file);
          setFiles((prev) =>
            prev.map((item) =>
              item.id === entry.id
                ? { ...item, status: "ready", source: response.source || "" }
                : item
            )
          );
        } catch (error) {
          setFiles((prev) =>
            prev.map((item) =>
              item.id === entry.id ? { ...item, status: "error" } : item
            )
          );
        }
      })
    );
  };

  const handleRemoveFile = (id) => {
    let removedFile;
    setFiles((prev) => {
      removedFile = prev.find((file) => file.id === id);
      return prev.filter((file) => file.id !== id);
    });
    if (removedFile?.source) {
      const userName = displayName || name || "Guest";
      deleteDocument(activeEnv, userName, passcode, removedFile.source).catch(() => {});
    }
  };

  return html`<div className="page">
    ${token
      ? html`<${LiveKitRoom}
          token=${token}
          serverUrl=${serverUrl}
          connect=${shouldConnect}
          audio=${{ echoCancellation: true, noiseSuppression: true, autoGainControl: true }}
          video=${false}
          onConnected=${() => {
            setStatus("Connected. Speak to Pepper!");
            const userName = displayName || name || "Guest";
            loadDocuments(userName);
            fetchSessionMeta(activeEnv)
              .then((data) => {
                setModelName(data?.model_name || "-");
              })
              .catch(() => {
                setModelName("-");
              });
          }}
          onDisconnected=${handleDisconnected}
          onError=${(error) => setStatus(error?.message || "LiveKit error.")}
          data-lk-theme="default"
        >
              <${SessionView}
                roomName=${roomName}
                displayName=${displayName}
                modelName=${modelName}
                onHangup=${handleDisconnected}
                files=${files}
                onAddFiles=${handleAddFiles}
                onRemoveFile=${handleRemoveFile}
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
