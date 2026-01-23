const TOKEN_ENDPOINT = "https://livekit.virtualemployees.solutions/api/token";

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

let room;
let localIdentity = null;
const transcriptEntries = new Map();

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
  createMessageElement({ senderLabel: "System", text, kind: "system", isInterim: false });
}

function resetChat() {
  transcriptEntries.clear();
  chatMessagesEl.innerHTML = "";
}

async function fetchToken(name, passcode) {
  const response = await fetch(TOKEN_ENDPOINT, {
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
  localIdentity = name;
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
    const senderIdentity = participantInfo?.identity || "unknown";

    if (!transcribedTrackId) {
      return;
    }

    const senderLabel = senderIdentity === localIdentity ? "You (speech)" : "Agent";
    const kind = senderIdentity === localIdentity ? "you-speech" : "agent";
    const key = segmentId ? `${senderIdentity}:${segmentId}` : null;
    upsertTranscriptMessage({
      key,
      senderLabel,
      kind,
      text: message,
      isFinal,
    });
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
  createMessageElement({ senderLabel: "You (typed)", text: message, kind: "you-typed" });

  try {
    await room.localParticipant.sendText(message, { topic: CHAT_TOPIC });
  } catch (error) {
    addSystemMessage(`Failed to send message: ${error.message}`);
  }
});
