const PROD_TOKEN_ENDPOINT = "https://livekit.virtualemployees.solutions/api/token";
const LOCAL_TOKEN_ENDPOINT = "http://localhost:8001/token";
const ENV_STORAGE_KEY = "lk-env";

const CHAT_TOPIC = "lk.chat";
const TRANSCRIPTION_TOPIC = "lk.transcription";

const envToggle = document.getElementById("env-toggle");
const envLabel = document.getElementById("env-label");
const nameInput = document.getElementById("name");
const passcodeInput = document.getElementById("passcode");
const roomEl = document.getElementById("room");
const participantEl = document.getElementById("participant");
const statusEl = document.getElementById("status");
const connectionState = document.getElementById("connection-state");
const stateLabel = document.getElementById("state-label");
const chatMessagesEl = document.getElementById("chat-messages");
const chatEmptyEl = document.getElementById("chat-empty");
const chatInput = document.getElementById("chat-input");
const chatSend = document.getElementById("chat-send");
const micToggle = document.getElementById("mic-toggle");
const keyboardToggle = document.getElementById("keyboard-toggle");
const textInput = document.getElementById("text-input");
const callToggle = document.getElementById("call-toggle");
const callLabel = document.getElementById("call-label");
const waveformCanvas = document.getElementById("waveform");
const voiceOrb = document.getElementById("voice-orb");

let activeEnv = resolveEnvironment();
let room = null;
let localIdentity = null;
let localAudioTrack = null;
let isMuted = false;
let isKeyboardOpen = false;

let audioContext = null;
let analyser = null;
let analyserData = null;
let waveformAnimationId = null;
let waveformWidth = 0;
let waveformHeight = 0;

const transcriptEntries = new Map();

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

function getTokenEndpoint() {
  return activeEnv === "local" ? LOCAL_TOKEN_ENDPOINT : PROD_TOKEN_ENDPOINT;
}

function updateEnvUI() {
  if (envLabel) {
    envLabel.textContent = activeEnv;
  }
}

function setStatus(message) {
  statusEl.textContent = message;
}

function setConnectionState(state, label) {
  connectionState.classList.remove("connecting", "connected", "error");
  if (state) {
    connectionState.classList.add(state);
  }
  stateLabel.textContent = label;
}

function setCallButtonState(state) {
  callToggle.classList.remove("connected", "disconnecting");
  if (state === "connected") {
    callToggle.classList.add("connected");
    callLabel.textContent = "Hang up";
  } else if (state === "disconnecting") {
    callToggle.classList.add("disconnecting");
    callLabel.textContent = "Ending";
  } else if (state === "connecting") {
    callLabel.textContent = "Calling";
  } else {
    callLabel.textContent = "Call";
  }
}

function setTextInputEnabled(enabled) {
  chatInput.disabled = !enabled;
  chatSend.disabled = !enabled;
  micToggle.disabled = !enabled;
  keyboardToggle.disabled = !enabled;
  if (!enabled) {
    isKeyboardOpen = false;
    keyboardToggle.setAttribute("aria-pressed", "false");
    textInput.classList.remove("active");
  }
}

function scrollChatToBottom() {
  chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
}

function updateEmptyState() {
  const hasMessages = chatMessagesEl.children.length > 0;
  chatEmptyEl.style.display = hasMessages ? "none" : "grid";
}

function createMessageElement({ senderLabel, text, kind, isInterim }) {
  const messageEl = document.createElement("div");
  messageEl.className = `message message--${kind}`;
  if (isInterim) {
    messageEl.classList.add("is-interim");
  }

  const metaEl = document.createElement("div");
  metaEl.className = "message-meta";
  metaEl.textContent = senderLabel;

  const textEl = document.createElement("div");
  textEl.className = "message-text";
  textEl.textContent = text;

  messageEl.append(metaEl, textEl);
  chatMessagesEl.appendChild(messageEl);
  updateEmptyState();
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
    const textEl = messageEl.querySelector(".message-text");
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
  createMessageElement({ senderLabel: "System", text, kind: "system", isInterim: false });
}

function clearConversation() {
  transcriptEntries.clear();
  chatMessagesEl.innerHTML = "";
  updateEmptyState();
}

function ensureCredentials() {
  const name = nameInput.value.trim();
  const passcode = passcodeInput.value.trim();
  if (!name || !passcode) {
    setStatus("Add name and passcode to start.");
    setConnectionState("error", "Missing details");
    return null;
  }
  return { name, passcode };
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

function prepareWaveform(stream) {
  stopWaveform();
  if (!stream) {
    return;
  }

  audioContext = new AudioContext();
  const source = audioContext.createMediaStreamSource(stream);
  analyser = audioContext.createAnalyser();
  analyser.fftSize = 2048;
  analyserData = new Uint8Array(analyser.fftSize);
  source.connect(analyser);

  resizeWaveform();
  drawWaveform();
}

function resizeWaveform() {
  if (!waveformCanvas) {
    return;
  }
  const dpr = window.devicePixelRatio || 1;
  waveformWidth = waveformCanvas.clientWidth * dpr;
  waveformHeight = waveformCanvas.clientHeight * dpr;
  waveformCanvas.width = waveformWidth;
  waveformCanvas.height = waveformHeight;
}

function stopWaveform() {
  if (waveformAnimationId) {
    cancelAnimationFrame(waveformAnimationId);
    waveformAnimationId = null;
  }
  if (audioContext) {
    audioContext.close();
    audioContext = null;
  }
  analyser = null;
  analyserData = null;
  if (voiceOrb) {
    voiceOrb.removeAttribute("data-level");
  }
}

function drawWaveform() {
  if (!analyser || !analyserData || !waveformCanvas) {
    return;
  }
  const ctx = waveformCanvas.getContext("2d");
  if (!ctx) {
    return;
  }

  analyser.getByteTimeDomainData(analyserData);
  ctx.clearRect(0, 0, waveformWidth, waveformHeight);

  ctx.lineWidth = 2;
  ctx.strokeStyle = "rgba(110, 231, 255, 0.9)";
  ctx.beginPath();

  let sumSquares = 0;
  for (let i = 0; i < analyserData.length; i += 1) {
    const value = analyserData[i] / 128 - 1;
    sumSquares += value * value;
    const x = (i / analyserData.length) * waveformWidth;
    const y = (1 - (value + 1) / 2) * waveformHeight;
    if (i === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  }

  ctx.stroke();

  const rms = Math.sqrt(sumSquares / analyserData.length);
  const level = rms > 0.2 ? "2" : rms > 0.08 ? "1" : "0";
  if (voiceOrb) {
    voiceOrb.setAttribute("data-level", level);
  }

  waveformAnimationId = requestAnimationFrame(drawWaveform);
}

async function connectSession() {
  if (room) {
    return;
  }

  const credentials = ensureCredentials();
  if (!credentials) {
    return;
  }

  setStatus("Requesting token...");
  setConnectionState("connecting", "Connecting");
  setCallButtonState("connecting");
  callToggle.disabled = true;

  try {
    const { token, room: roomName, url } = await fetchToken(
      credentials.name,
      credentials.passcode
    );

    room = new LivekitClient.Room({
      adaptiveStream: true,
      dynacast: true,
    });

    room.on(LivekitClient.RoomEvent.ParticipantConnected, (participant) => {
      addSystemMessage(`Participant joined: ${participant.identity}`);
    });

    room.on(LivekitClient.RoomEvent.ParticipantDisconnected, (participant) => {
      addSystemMessage(`Participant left: ${participant.identity}`);
    });

    room.on(LivekitClient.RoomEvent.TrackSubscribed, (track, publication, participant) => {
      if (track.kind === "audio") {
        const audioEl = track.attach();
        audioEl.style.display = "none";
        document.body.appendChild(audioEl);
        addSystemMessage(`Audio track subscribed from ${participant.identity}`);
      }
    });

    room.on(LivekitClient.RoomEvent.Disconnected, () => {
      setStatus("Disconnected.");
      setConnectionState(null, "Disconnected");
      setCallButtonState(null);
      setTextInputEnabled(false);
      roomEl.textContent = "-";
      participantEl.textContent = "-";
      localIdentity = null;
      localAudioTrack?.stop();
      localAudioTrack = null;
      stopWaveform();
      clearConversation();
      room = null;
      callToggle.disabled = false;
    });

    await room.connect(url, token);
    await room.startAudio();

    localAudioTrack = await LivekitClient.createLocalAudioTrack({
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    });

    await room.localParticipant.publishTrack(localAudioTrack);

    const stream = new MediaStream([localAudioTrack.mediaStreamTrack]);
    prepareWaveform(stream);

    roomEl.textContent = roomName;
    participantEl.textContent = credentials.name;
    localIdentity = room.localParticipant?.identity || credentials.name;

    setStatus("Connected. Speak to Robbie!");
    setConnectionState("connected", "Connected");
    setCallButtonState("connected");
    callToggle.disabled = false;
    setTextInputEnabled(true);

    room.registerTextStreamHandler(TRANSCRIPTION_TOPIC, async (reader, participantInfo) => {
      const attributes = reader.info?.attributes || {};
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
      const senderLabel = isLocalSpeaker ? "You" : "Agent";
      const key = segmentId ? `${senderIdentity}:${segmentId}` : null;

      let lastText = "";
      if (typeof reader.read === "function") {
        while (true) {
          const { value, done } = await reader.read();
          if (done) {
            break;
          }
          if (value) {
            lastText = value;
            upsertTranscriptMessage({
              key,
              senderLabel,
              kind,
              text: value,
              isFinal: false,
            });
          }
        }
      } else {
        lastText = await reader.readAll();
      }

      if (lastText) {
        upsertTranscriptMessage({
          key,
          senderLabel,
          kind,
          text: lastText,
          isFinal: true,
        });
      }
    });

    addSystemMessage("Transcription stream ready. Start speaking.");
  } catch (error) {
    const message = error?.message || "Failed to connect.";
    setStatus(message);
    setConnectionState("error", "Error");
    setCallButtonState(null);
    callToggle.disabled = false;
    room = null;
    stopWaveform();
  }
}

async function disconnectSession() {
  if (!room) {
    return;
  }
  setStatus("Disconnecting...");
  setConnectionState("connecting", "Disconnecting");
  setCallButtonState("disconnecting");
  callToggle.disabled = true;

  try {
    await room.disconnect();
  } finally {
    room = null;
    localAudioTrack?.stop();
    localAudioTrack = null;
    stopWaveform();
    clearConversation();
    setCallButtonState(null);
    callToggle.disabled = false;
    setConnectionState(null, "Disconnected");
    setTextInputEnabled(false);
  }
}

function toggleMute() {
  if (!room || !room.localParticipant) {
    return;
  }
  isMuted = !isMuted;
  room.localParticipant.setMicrophoneEnabled(!isMuted).catch(() => {
    addSystemMessage("Could not update microphone state.");
  });
  micToggle.setAttribute("aria-pressed", String(isMuted));
}

function toggleKeyboard() {
  isKeyboardOpen = !isKeyboardOpen;
  keyboardToggle.setAttribute("aria-pressed", String(isKeyboardOpen));
  textInput.classList.toggle("active", isKeyboardOpen);
  if (isKeyboardOpen) {
    chatInput.focus();
  }
}

async function sendMessage() {
  if (!room || chatInput.disabled) {
    return;
  }
  const message = chatInput.value.trim();
  if (!message) {
    return;
  }

  chatInput.value = "";
  createMessageElement({ senderLabel: "You", text: message, kind: "user" });

  try {
    await room.localParticipant.sendText(message, { topic: CHAT_TOPIC });
  } catch (error) {
    addSystemMessage(`Failed to send message: ${error.message}`);
  }
}

updateEnvUI();
setTextInputEnabled(false);

if (envToggle) {
  envToggle.addEventListener("click", () => {
    activeEnv = activeEnv === "local" ? "prod" : "local";
    localStorage.setItem(ENV_STORAGE_KEY, activeEnv);
    updateEnvUI();
  });
}

callToggle.addEventListener("click", async () => {
  if (room) {
    await disconnectSession();
  } else {
    await connectSession();
  }
});

micToggle.addEventListener("click", () => {
  toggleMute();
});

keyboardToggle.addEventListener("click", () => {
  toggleKeyboard();
});

chatSend.addEventListener("click", () => {
  sendMessage();
});

chatInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    sendMessage();
  }
});

window.addEventListener("resize", () => {
  resizeWaveform();
});
