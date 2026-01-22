const TOKEN_ENDPOINT = "https://livekit.virtualemployees.solutions/api/token";

const form = document.getElementById("connect-form");
const connectBtn = document.getElementById("connect");
const disconnectBtn = document.getElementById("disconnect");
const statusEl = document.getElementById("status");
const roomEl = document.getElementById("room");
const participantEl = document.getElementById("participant");
const logEl = document.getElementById("log");

let room;

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
    roomEl.textContent = "-";
    participantEl.textContent = "-";
  });

  await room.connect(url, token);

  const localTrack = await LivekitClient.createLocalAudioTrack();
  await room.localParticipant.publishTrack(localTrack);

  roomEl.textContent = roomName;
  participantEl.textContent = name;
  setButtons(true);
  setStatus("Connected. Speak to the agent!");
  log(`Connected to ${roomName}`);
}

async function disconnect() {
  if (!room) {
    return;
  }
  setStatus("Disconnecting...");
  await room.disconnect();
  room = null;
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
