const PROD_TOKEN_ENDPOINT = "https://livekit.virtualemployees.solutions/api/token";
const LOCAL_TOKEN_ENDPOINT = "http://localhost:8001/token";
const ENV_STORAGE_KEY = "lk-env";

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

let activeEnv = resolveEnvironment();
const envToggle = document.getElementById("env-toggle");
const envLabel = document.getElementById("env-label");

function getTokenEndpoint() {
  return activeEnv === "local" ? LOCAL_TOKEN_ENDPOINT : PROD_TOKEN_ENDPOINT;
}

function updateEnvUI() {
  if (envLabel) {
    envLabel.textContent = activeEnv;
  }
}

function persistEnv(env) {
  localStorage.setItem(ENV_STORAGE_KEY, env);
}

updateEnvUI();

if (envToggle) {
  envToggle.addEventListener("click", () => {
    activeEnv = activeEnv === "local" ? "prod" : "local";
    persistEnv(activeEnv);
    updateEnvUI();
  });
}

const form = document.getElementById("connect-form");
const connectBtn = document.getElementById("connect");
const disconnectBtn = document.getElementById("disconnect");
const statusEl = document.getElementById("status");
const roomEl = document.getElementById("room");
const participantEl = document.getElementById("participant");
const logEl = document.getElementById("log");
const chatMessagesEl = document.getElementById("chat-messages");
const chatForm = document.getElementById("chat-form");
const chatInput = document.getElementById("chat-input");
const chatSend = document.getElementById("chat-send");
const bodyEl = document.body;
const voiceOrb = document.getElementById("voice-orb");

let room;
let localIdentity = null;
const transcriptEntries = new Map();
const speakingTimeouts = new Map();

const CHAT_TOPIC = "lk.chat";
const TRANSCRIPTION_TOPIC = "lk.transcription";

function log(message) {
  const entry = document.createElement("div");
  entry.textContent = message;
  logEl.prepend(entry);
}

function setStatus(message) {
  statusEl.textContent = message;
}

function setButtons(connected) {
  connectBtn.disabled = connected;
  disconnectBtn.disabled = !connected;
}

function setChatEnabled(enabled) {
  chatInput.disabled = !enabled;
  chatSend.disabled = !enabled;
}

function scrollChatToBottom() {
  chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
}

function createMessageElement({ senderLabel, text, kind, isInterim }) {
  const messageEl = document.createElement("div");
  messageEl.className = `message message--${kind}`;
  if (kind.startsWith("you")) {
    messageEl.classList.add("message--me");
  }
  if (isInterim) {
    messageEl.classList.add("is-interim");
  }

  const metaEl = document.createElement("div");
  metaEl.className = "message__meta";
  metaEl.textContent = senderLabel;

  const textEl = document.createElement("div");
  textEl.className = "message__text";
  textEl.textContent = text;

  messageEl.append(metaEl, textEl);
  chatMessagesEl.appendChild(messageEl);
  scrollChatToBottom();
  return messageEl;
}

function upsertTranscriptMessage({ key, senderLabel, kind, text, isFinal }) {
  if (!key) {
    createMessageElement({ senderLabel, text, kind, isInterim: !isFinal });
    return;
  }

  let messageEl = transcriptEntries.get(key);
  if (!messageEl) {
    messageEl = createMessageElement({
      senderLabel,
      text,
      kind,
      isInterim: !isFinal,
    });
    transcriptEntries.set(key, messageEl);
  } else {
    const textEl = messageEl.querySelector(".message__text");
    if (textEl) {
      textEl.textContent = text;
    }
    messageEl.classList.toggle("is-interim", !isFinal);
  }

  if (isFinal) {
    transcriptEntries.delete(key);
  }
}

function addSystemMessage(text) {
  createMessageElement({ senderLabel: "System:", text, kind: "system", isInterim: false });
}

function resetChat() {
  transcriptEntries.clear();
  chatMessagesEl.innerHTML = "";
}

function setSpeaking(kind, isActive) {
  const className = `speaking-${kind}`;
  if (!bodyEl) {
    return;
  }

  if (isActive) {
    bodyEl.classList.add(className);
    if (voiceOrb) {
      voiceOrb.setAttribute("data-speaking", kind);
    }
    const existingTimeout = speakingTimeouts.get(kind);
    if (existingTimeout) {
      clearTimeout(existingTimeout);
    }
    const timeoutId = setTimeout(() => {
      bodyEl.classList.remove(className);
      if (voiceOrb && voiceOrb.getAttribute("data-speaking") === kind) {
        voiceOrb.removeAttribute("data-speaking");
      }
      speakingTimeouts.delete(kind);
    }, 1200);
    speakingTimeouts.set(kind, timeoutId);
  } else {
    const existingTimeout = speakingTimeouts.get(kind);
    if (existingTimeout) {
      clearTimeout(existingTimeout);
      speakingTimeouts.delete(kind);
    }
    bodyEl.classList.remove(className);
    if (voiceOrb && voiceOrb.getAttribute("data-speaking") === kind) {
      voiceOrb.removeAttribute("data-speaking");
    }
  }
}

async function fetchToken(name, passcode) {
  const response = await fetch(getTokenEndpoint(), {
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

async function connect(name, passcode) {
  setStatus("Requesting token...");
  const tokenEndpoint = getTokenEndpoint();
  log(`Environment: ${activeEnv} (${tokenEndpoint})`);
  const { token, room: roomName, url } = await fetchToken(name, passcode);

  setStatus("Connecting to room...");
  room = new LivekitClient.Room({
    adaptiveStream: true,
    dynacast: true,
  });

  room.on(LivekitClient.RoomEvent.ParticipantConnected, (participant) => {
    log(`Participant joined: ${participant.identity}`);
  });

  room.on(LivekitClient.RoomEvent.ParticipantDisconnected, (participant) => {
    log(`Participant left: ${participant.identity}`);
  });

  room.on(LivekitClient.RoomEvent.TrackSubscribed, (track, publication, participant) => {
    if (track.kind === "audio") {
      const audioEl = track.attach();
      audioEl.style.display = "none";
      document.body.appendChild(audioEl);
      log(`Audio track subscribed from ${participant.identity}`);
    }
  });

  room.on(LivekitClient.RoomEvent.Disconnected, () => {
    setStatus("Disconnected.");
    setButtons(false);
    setChatEnabled(false);
    roomEl.textContent = "-";
    participantEl.textContent = "-";
    localIdentity = null;
  });

  await room.connect(url, token);

  const localTrack = await LivekitClient.createLocalAudioTrack();
  await room.localParticipant.publishTrack(localTrack);

  roomEl.textContent = roomName;
  participantEl.textContent = name;
  localIdentity = room.localParticipant?.identity || name;
  setButtons(true);
  setChatEnabled(true);
  setStatus("Connected. Speak to the agent!");
  log(`Connected to ${roomName}`);

  room.registerTextStreamHandler(TRANSCRIPTION_TOPIC, async (reader, participantInfo) => {
    const message = await reader.readAll();
    const attributes = reader.info?.attributes || {};
    const isFinal = attributes["lk.transcription_final"] === "true";
    const segmentId = attributes["lk.segment_id"];
    const transcribedTrackId = attributes["lk.transcribed_track_id"];
    const senderIdentity =
      participantInfo?.identity || reader.info?.participantIdentity || "unknown";

    if (!transcribedTrackId) {
      return;
    }

    const localId = room?.localParticipant?.identity || localIdentity;
    const isLocalSpeaker = localId && senderIdentity === localId;
    const kind = isLocalSpeaker ? "user" : "agent";
    const senderLabel = isLocalSpeaker ? "Me:" : "Agent:";
    const messageKind = isLocalSpeaker ? "you-speech" : "agent";
    const key = segmentId ? `${senderIdentity}:${segmentId}` : null;
    upsertTranscriptMessage({
      key,
      senderLabel,
      kind: messageKind,
      text: message,
      isFinal,
    });

    if (!isFinal) {
      setSpeaking(kind, true);
    } else {
      setSpeaking(kind, false);
    }
  });

  addSystemMessage("Transcription stream ready. Start speaking or type below.");
}

async function disconnect() {
  if (!room) {
    return;
  }
  setStatus("Disconnecting...");
  await room.disconnect();
  room = null;
  resetChat();
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = document.getElementById("name").value.trim();
  const passcode = document.getElementById("passcode").value.trim();

  if (!name || !passcode) {
    setStatus("Please enter name and passcode.");
    return;
  }

  connectBtn.disabled = true;
  try {
    await connect(name, passcode);
  } catch (error) {
    setStatus(error.message);
    setButtons(false);
  }
});

disconnectBtn.addEventListener("click", async () => {
  await disconnect();
});

chatForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!room || chatInput.disabled) {
    return;
  }

  const message = chatInput.value.trim();
  if (!message) {
    return;
  }

  chatInput.value = "";
  createMessageElement({ senderLabel: "Me:", text: message, kind: "you-typed" });

  try {
    await room.localParticipant.sendText(message, { topic: CHAT_TOPIC });
  } catch (error) {
    addSystemMessage(`Failed to send message: ${error.message}`);
  }
});
