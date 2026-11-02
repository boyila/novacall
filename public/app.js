// ─────────────────────────────────────────────
//  NovaCall — app.js
//  Fixes: API key server-side, iOS Safari audio,
//         speaker toggle, guest invite card,
//         PWA push + incoming call screen
// ─────────────────────────────────────────────

const $ = (id) => document.getElementById(id);

const state = {
  socket: null,
  roomId: null,
  name: "",
  hostName: "Host",
  role: null,
  joined: false,
  localStream: null,
  pc: null,
  pendingCandidates: [],
  connected: false,
  roomState: null,
  iceServers: [],
  roomUrl: "",
  callStartAt: null,
  reconnecting: false,
  manualDisconnect: false,
  reconnectTimer: null,
  timerHandle: null,
  speakerOn: false,
  audioUnlocked: false,
  swReg: null,
  pushSubscribed: false,
  offerPending: false,   // prevents duplicate offers during room-state bursts
};

const els = {};

function cacheEls() {
  els.homeView          = $("homeView");
  els.roomView          = $("roomView");
  els.homeName          = $("homeName");
  els.createRoomBtn     = $("createRoomBtn");
  els.roomTitle         = $("roomTitle");
  els.roomSubtitle      = $("roomSubtitle");
  els.connectionPill    = $("connectionPill");
  els.pillText          = $("pillText");
  els.timer             = $("timer");
  els.roomLinkText      = $("roomLinkText");
  els.copyBtn           = $("copyBtn");
  els.hostName          = $("hostName");
  els.guestName         = $("guestName");
  els.roomHint          = $("roomHint");
  els.joinBtn           = $("joinBtn");
  els.disconnectBtn     = $("disconnectBtn");
  els.muteBtn           = $("muteBtn");
  els.muteIcon          = $("muteIcon");
  els.muteLabel         = $("muteLabel");
  els.speakerBtn        = $("speakerBtn");
  els.speakerIcon       = $("speakerIcon");
  els.speakerLabel      = $("speakerLabel");
  els.bottomNote        = $("bottomNote");
  els.remoteAudio       = $("remoteAudio");
  els.ringAudio         = $("ringAudio");
  els.guestJoinCard     = $("guestJoinCard");
  els.mainCard          = $("mainCard");
  els.guestJoinBtn      = $("guestJoinBtn");
  els.inviteAvatar      = $("inviteAvatar");
  els.inviteHostName    = $("inviteHostName");
  // incoming call screen
  els.incomingScreen    = $("incomingCallScreen");
  els.incomingAvatar    = $("incomingAvatar");
  els.incomingName      = $("incomingCallerName");
  els.acceptBtn         = $("acceptBtn");
  els.declineBtn        = $("declineBtn");
  els.iosInstallHint    = $("iosInstallHint");
}

// ── Routing ──────────────────────────────────

function roomIdFromPath() {
  const m = window.location.pathname.match(/^\/room\/([^/]+)$/i);
  return m ? decodeURIComponent(m[1]) : null;
}
function hostFromQuery() {
  return (new URLSearchParams(window.location.search).get("host") || "Host").trim() || "Host";
}

// ── iOS install hint ─────────────────────────
// Show "Add to Home Screen" tip on iPhone Safari (not in standalone mode)
function maybeShowiOSHint() {
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const isStandalone = window.navigator.standalone === true;
  if (isIOS && !isStandalone && els.iosInstallHint) {
    els.iosInstallHint.classList.remove("hidden");
  }
}

// ── Service Worker + Push ─────────────────────

async function registerSW() {
  if (!("serviceWorker" in navigator)) return;
  try {
    state.swReg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  } catch (e) {
    console.warn("SW registration failed:", e);
  }
}

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

async function subscribeToPush(roomId) {
  if (!state.swReg || state.pushSubscribed) return;
  if (!("PushManager" in window)) return;

  try {
    // Ask permission
    const permission = await Notification.requestPermission();
    if (permission !== "granted") return;

    // Fetch VAPID public key from server
    const res = await fetch("/api/vapid-public-key");
    const { key } = await res.json();
    if (!key) return;

    // Subscribe
    const sub = await state.swReg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(key),
    });

    // Send subscription to server, associated with this room
    await fetch("/api/push-subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ roomId, subscription: sub }),
    });

    state.pushSubscribed = true;
  } catch (e) {
    console.warn("Push subscribe failed:", e);
  }
}

// ── Incoming call screen (in-tab ring) ───────
// Used when the host already has the tab open when guest joins

function showIncomingCall(callerName) {
  els.incomingAvatar.textContent = callerName.charAt(0).toUpperCase() || "?";
  els.incomingName.textContent   = callerName;
  els.incomingScreen.classList.remove("hidden");
  // Start ringing
  els.ringAudio.currentTime = 0;
  els.ringAudio.play().catch(() => {});
  // Auto-dismiss after 30s if no answer
  state._ringTimeout = setTimeout(() => hideIncomingCall(), 30000);
}

function hideIncomingCall() {
  els.incomingScreen.classList.add("hidden");
  els.ringAudio.pause();
  els.ringAudio.currentTime = 0;
  if (state._ringTimeout) { clearTimeout(state._ringTimeout); state._ringTimeout = null; }
  // Tell SW to close any push notification for this room too
  if (navigator.serviceWorker?.controller) {
    navigator.serviceWorker.controller.postMessage({ type: "stop-ring" });
  }
}

// ── Timer ────────────────────────────────────

function tickTimer() {
  if (!state.callStartAt) { els.timer.classList.add("hidden"); return; }
  els.timer.classList.remove("hidden");
  els.timer.textContent = formatTimer(Math.floor((Date.now() - state.callStartAt) / 1000));
}
function formatTimer(s) {
  return `${String(Math.floor(s / 60)).padStart(2,"0")}:${String(s % 60).padStart(2,"0")}`;
}
function startTimer() {
  state.callStartAt = Date.now(); tickTimer();
  if (state.timerHandle) clearInterval(state.timerHandle);
  state.timerHandle = setInterval(tickTimer, 1000);
}
function stopTimer() {
  if (state.timerHandle) clearInterval(state.timerHandle);
  state.timerHandle = null; state.callStartAt = null;
  els.timer.classList.add("hidden"); els.timer.textContent = "00:00";
}

// ── Clipboard ────────────────────────────────

async function copyText(text) {
  try { if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; } } catch {}
  try {
    const ta = Object.assign(document.createElement("textarea"), { value: text });
    Object.assign(ta.style, { position:"fixed", opacity:"0" });
    document.body.appendChild(ta); ta.focus(); ta.select();
    const ok = document.execCommand("copy"); document.body.removeChild(ta); return ok;
  } catch { return false; }
}

// ── ICE servers ───────────────────────────────

async function loadIceServers() {
  try {
    const res = await fetch("/api/ice", { cache: "no-store" });
    if (!res.ok) throw new Error();
    const data = await res.json();
    state.iceServers = Array.isArray(data.iceServers) && data.iceServers.length
      ? data.iceServers
      : [{ urls:"stun:stun.l.google.com:19302" }, { urls:"stun:global.stun.twilio.com:3478" }];
  } catch {
    state.iceServers = [{ urls:"stun:stun.l.google.com:19302" }, { urls:"stun:global.stun.twilio.com:3478" }];
  }
}

// ── iOS Safari audio unlock ───────────────────

function unlockAudioOnGesture() {
  if (state.audioUnlocked) return;
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const buf = ctx.createBuffer(1, 1, 22050);
    const src = ctx.createBufferSource();
    src.buffer = buf; src.connect(ctx.destination); src.start(0); ctx.close();
  } catch {}
  state.audioUnlocked = true;
}

async function playRemoteAudio() {
  const audio = els.remoteAudio;
  if (!audio.srcObject) return;
  try { await audio.play(); } catch (e) {
    if (e.name === "NotAllowedError") {
      const resume = async () => { try { await audio.play(); } catch {} };
      document.addEventListener("touchstart", resume, { once: true });
      document.addEventListener("click",      resume, { once: true });
    }
  }
}

// ── Speaker toggle ────────────────────────────

async function applySpeakerMode() {
  const audio = els.remoteAudio;
  if (!audio) return;
  if (typeof audio.setSinkId === "function") {
    try {
      if (state.speakerOn) {
        await audio.setSinkId("");
      } else {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const ear = devices.find((d) => d.kind === "audiooutput" && /earpiece|receiver/i.test(d.label));
        await audio.setSinkId(ear ? ear.deviceId : "");
      }
    } catch {}
  }
  els.speakerIcon.textContent  = state.speakerOn ? "🔊" : "🔈";
  els.speakerLabel.textContent = state.speakerOn ? "Loud" : "Speaker";
  els.speakerBtn.classList.toggle("active", state.speakerOn);
}

// ── UI helpers ────────────────────────────────

function updatePill(mode, text) {
  els.connectionPill.classList.remove("pill-blue","pill-green","pill-yellow");
  els.connectionPill.classList.add(mode === "green" ? "pill-green" : mode === "yellow" ? "pill-yellow" : "pill-blue");
  els.pillText.textContent = text;
}

function updateParticipants() {
  els.hostName.textContent  = state.roomState?.host?.name  || state.hostName || "—";
  els.guestName.textContent = state.roomState?.guest?.name || "—";
}

function updateRoomTexts() {
  const hn = state.hostName || "Host";
  if (state.connected) {
    els.roomTitle.textContent    = "NovaCall";
    els.roomSubtitle.textContent = `Connected with ${state.role === "host" ? (state.roomState?.guest?.name || "Guest") : hn}`;
  } else if (state.role === "host") {
    els.roomTitle.textContent    = hn;
    els.roomSubtitle.textContent = `${hn} is waiting in the room`;
  } else {
    els.roomTitle.textContent    = `Join ${hn}'s room`;
    els.roomSubtitle.textContent = `${hn} invited you`;
  }
  updateParticipants();
}

function updateConnectedUI(connected) {
  state.connected = connected;
  els.roomView.classList.toggle("connected-glow",    connected);
  els.roomView.classList.toggle("reconnecting-glow", state.reconnecting && !connected);
  if (connected) {
    hideIncomingCall(); // dismiss ring when call connects
    updatePill("green", "Call connected");
    els.roomHint.className   = "hint hint-green";
    els.roomHint.textContent = "Connected. Voice is live.";
    els.bottomNote.textContent = "Green = connected. End when done.";
    startTimer();
  } else if (state.reconnecting) {
    updatePill("yellow", "Reconnecting…");
    els.roomHint.className   = "hint hint-blue";
    els.roomHint.textContent = "Reconnecting automatically…";
    els.bottomNote.textContent = "Network changed. Trying to reconnect…";
    stopTimer();
  } else {
    updatePill("blue", state.role === "host" ? "You are hosting" : "Ready to join");
    els.roomHint.className   = "hint hint-blue";
    els.bottomNote.textContent = state.role === "host"
      ? "Share the link. Your friend will see a personalised invite."
      : "Tap Join Call to request microphone access.";
    stopTimer();
  }
}

function showHome() { els.homeView.classList.remove("hidden"); els.roomView.classList.add("hidden"); }
function showRoom() { els.homeView.classList.add("hidden"); els.roomView.classList.remove("hidden"); }

function showGuestInviteCard(hostName) {
  els.inviteAvatar.textContent   = hostName.trim().charAt(0).toUpperCase() || "?";
  els.inviteHostName.textContent = hostName;
  els.guestJoinCard.classList.remove("hidden");
  els.mainCard.classList.add("hidden");
}
function transitionToMainCard() {
  els.guestJoinCard.classList.add("hidden");
  els.mainCard.classList.remove("hidden");
}

// ── WebRTC ────────────────────────────────────

async function ensureLocalStream() {
  if (state.localStream) return state.localStream;
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation:true, noiseSuppression:true, autoGainControl:true, channelCount:1 },
  });
  state.localStream = stream;
  return stream;
}

function closePeerConnection() {
  if (state.pc) {
    try { state.pc.ontrack = null; } catch {}
    try { state.pc.onicecandidate = null; } catch {}
    try { state.pc.onconnectionstatechange = null; } catch {}
    try { state.pc.close(); } catch {}
  }
  state.pc = null;
  state.pendingCandidates = [];
  els.remoteAudio.srcObject = null;
}

function stopLocalAudio() {
  if (state.localStream) { state.localStream.getTracks().forEach((t) => t.stop()); state.localStream = null; }
}

function createPeerConnection() {
  if (state.pc) return state.pc;
  const pc = new RTCPeerConnection({
    iceServers: state.iceServers.length ? state.iceServers
      : [{ urls:"stun:stun.l.google.com:19302" }, { urls:"stun:global.stun.twilio.com:3478" }],
  });
  state.pc = pc;
  if (state.localStream) state.localStream.getTracks().forEach((t) => pc.addTrack(t, state.localStream));
  pc.ontrack = (e) => {
    const [stream] = e.streams;
    if (stream) { els.remoteAudio.srcObject = stream; playRemoteAudio(); applySpeakerMode(); }
  };
  pc.onicecandidate = (e) => {
    if (e.candidate && state.socket && state.roomId)
      state.socket.emit("signal", { roomId: state.roomId, candidate: e.candidate });
  };
  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;
    console.log("[NovaCall] connectionState:", s);
    if (s === "connected") {
      state.reconnecting = false;
      state.offerPending = false;  // reset so re-offer works if call drops and reconnects
      updateConnectedUI(true);
      if (state.socket && state.roomId) state.socket.emit("peer-connected", { roomId: state.roomId });
    } else if (s === "disconnected" || s === "failed") {
      if (!state.manualDisconnect) {
        if (state.connected) { state.reconnecting = true; scheduleReconnect(); }
        updateConnectedUI(false);
      }
    }
  };
  pc.onicegatheringstatechange = () => console.log("[NovaCall] iceGatheringState:", pc.iceGatheringState);
  pc.oniceconnectionstatechange = () => console.log("[NovaCall] iceConnectionState:", pc.iceConnectionState);
  return pc;
}

function flushCandidates() {
  if (!state.pc?.remoteDescription) return;
  while (state.pendingCandidates.length)
    state.pc.addIceCandidate(new RTCIceCandidate(state.pendingCandidates.shift())).catch(() => {});
}

async function createOffer() {
  const pc = createPeerConnection();
  if (pc.signalingState !== "stable") {
    console.warn("[NovaCall] createOffer skipped — signalingState:", pc.signalingState);
    return;
  }
  console.log("[NovaCall] creating offer, iceServers:", state.iceServers.length);
  try {
    const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: false });
    await pc.setLocalDescription(offer);
    console.log("[NovaCall] offer sent");
    state.socket.emit("signal", { roomId: state.roomId, description: pc.localDescription });
  } catch(e) {
    console.error("[NovaCall] createOffer error:", e);
  }
}

async function onSignal(message) {
  if (!message || !state.roomId) return;
  console.log("[NovaCall] signal received:", message.description?.type || "candidate");
  if (message.description) {
    const pc = createPeerConnection();
    try {
      if (message.description.type === "offer") {
        console.log("[NovaCall] handling offer, getting mic...");
        await ensureLocalStream();
        if (state.localStream && pc.getSenders().length === 0) {
          state.localStream.getTracks().forEach((t) => pc.addTrack(t, state.localStream));
        }
        await pc.setRemoteDescription(new RTCSessionDescription(message.description));
        flushCandidates();
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        console.log("[NovaCall] answer sent");
        state.socket.emit("signal", { roomId: state.roomId, description: pc.localDescription });
      } else if (message.description.type === "answer") {
        if (pc.signalingState === "have-local-offer") {
          console.log("[NovaCall] setting answer");
          await pc.setRemoteDescription(new RTCSessionDescription(message.description));
          flushCandidates();
        } else {
          console.warn("[NovaCall] answer ignored, signalingState:", pc.signalingState);
        }
      }
    } catch(e) { console.error("[NovaCall] onSignal error:", e); }
  }
  if (message.candidate) {
    if (state.pc?.remoteDescription) {
      state.pc.addIceCandidate(new RTCIceCandidate(message.candidate)).catch((e) => console.warn("[NovaCall] ICE add failed:", e));
    } else {
      state.pendingCandidates.push(message.candidate);
    }
  }
}

function scheduleReconnect() {
  if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
  state.reconnectTimer = setTimeout(() => {
    if (!state.socket || !state.roomId || state.manualDisconnect) return;
    state.socket.emit(state.role === "host" ? "create-room" : "join-room",
      { roomId: state.roomId, name: state.name });
  }, 1200);
}

// ── Socket ────────────────────────────────────

function connectSocket() {
  state.socket = io({
    // Force WebSocket only — skip polling to avoid the transport-upgrade
    // disconnect/reconnect cycle that races with WebRTC negotiation
    transports: ["websocket"],
    reconnection: true,
    reconnectionDelay: 500,
    reconnectionDelayMax: 2500,
    reconnectionAttempts: Infinity,
  });

  state.socket.on("connect", () => {
    if (state.joined && !state.manualDisconnect)
      state.socket.emit(state.role === "host" ? "create-room" : "join-room",
        { roomId: state.roomId, name: state.name });
  });

  state.socket.on("room-state", (room) => {
    state.roomState = room;
    state.hostName  = room?.host?.name || state.hostName || "Host";
    updateRoomTexts();
    if (room.connected) { state.reconnecting = false; updateConnectedUI(true); return; }
    // If no guest online, we're just idle — clear reconnecting flag
    if (!room.guest?.online) state.reconnecting = false;
    updateConnectedUI(false);

    // Host triggers the WebRTC offer when guest comes online.
    // offerPending guard prevents duplicate offers if room-state fires multiple times.
    if (state.role === "host" && room.guest?.online && state.joined && state.localStream && !state.connected) {
      if (!state.offerPending) {
        state.offerPending = true;
        console.log("[NovaCall] guest online — scheduling offer");
        setTimeout(async () => {
          await createOffer();
        }, 500);
      }
    }
  });

  state.socket.on("participant-joined", (payload) => {
    if (payload?.role === "guest" && state.role === "host") {
      // Show incoming call ring UI — but don't block WebRTC.
      // The offer is triggered via room-state when guest comes online.
      showIncomingCall(payload.name || "Someone");
      updatePill("yellow", "Incoming call…");
    }
  });

  state.socket.on("participant-left", () => {
    if (!state.manualDisconnect) {
      state.reconnecting = false;
      state.offerPending = false;  // guest left — allow fresh offer when they rejoin
      updateConnectedUI(false);
      updateRoomTexts();
    }
  });

  state.socket.on("signal", onSignal);

  state.socket.on("disconnect", () => {
    if (!state.manualDisconnect) {
      // Only show "reconnecting" if a call was already active or a guest was present.
      // Don't flip to reconnecting state just from Socket.IO's transport-upgrade disconnect on page load.
      if (state.connected || (state.roomState?.guest?.online)) {
        state.reconnecting = true;
        scheduleReconnect();
      }
      updateConnectedUI(false);
    }
  });
}

// ── Call actions ──────────────────────────────

async function startHostRoom() {
  if (state.joined) return;
  unlockAudioOnGesture();
  try {
    updatePill("yellow", "Requesting microphone…");
    await ensureLocalStream();
  } catch {
    alert("Microphone access is required to enter the room.");
    updatePill("blue", "Microphone permission needed");
    return;
  }
  state.role = "host"; state.joined = true;
  state.socket.emit("create-room", { roomId: state.roomId, name: state.name });
  updateRoomTexts(); updateConnectedUI(false);
  els.joinBtn.textContent = "Waiting…"; els.joinBtn.disabled = true;
  els.bottomNote.textContent = "You are in the room. Waiting for your friend.";
  // Subscribe to push so server can ring you when guest joins
  await subscribeToPush(state.roomId);
}

async function joinCall() {
  unlockAudioOnGesture();
  try {
    updatePill("yellow", "Requesting microphone…");
    await ensureLocalStream();
  } catch {
    alert("Microphone access is required to join the call.");
    updatePill("blue", "Microphone permission needed");
    return;
  }
  state.role = "guest"; state.joined = true;
  state.socket.emit("join-room", { roomId: state.roomId, name: state.name });
  els.joinBtn.textContent = "Joining…"; els.joinBtn.disabled = true;
  updateRoomTexts(); updateConnectedUI(false);
}

async function disconnectRoom() {
  state.manualDisconnect = true; state.reconnecting = false; state.joined = false;
  if (state.socket && state.roomId) state.socket.emit("leave-room", { roomId: state.roomId });
  stopTimer(); hideIncomingCall(); closePeerConnection(); stopLocalAudio();
  try { state.socket?.disconnect(); } catch {}
  window.location.href = "/";
}

function updateJoinButton() {
  if (state.connected) { els.joinBtn.textContent = "Connected"; els.joinBtn.disabled = true; }
  else if (state.joined) { els.joinBtn.textContent = state.role === "host" ? "Waiting…" : "Joining…"; els.joinBtn.disabled = true; }
  else { els.joinBtn.textContent = state.role === "host" ? "Enter Room" : "Join Call"; els.joinBtn.disabled = false; }
}

// ── Event bindings ────────────────────────────

function bindEvents() {
  els.createRoomBtn.addEventListener("click", () => {
    const name = els.homeName.value.trim();
    if (!name) { alert("Please enter your name."); return; }
    const roomId = crypto.randomUUID().slice(0, 6).toUpperCase();
    localStorage.setItem("novacall_name", name);
    localStorage.setItem("novacall_host_room_id", roomId);
    window.location.href = `/room/${roomId}?host=${encodeURIComponent(name)}`;
  });

  els.copyBtn.addEventListener("click", async () => {
    if (!state.roomUrl) return;
    const ok = await copyText(state.roomUrl);
    if (ok) { const p = els.copyBtn.textContent; els.copyBtn.textContent = "Copied ✓"; setTimeout(() => { els.copyBtn.textContent = p || "Copy"; }, 1600); }
    else alert("Copy failed");
  });

  els.joinBtn.addEventListener("click", async () => {
    if (state.connected) return;
    if (state.role === "host") await startHostRoom();
    else await joinCall();
    updateJoinButton();
  });

  els.guestJoinBtn.addEventListener("click", async () => {
    unlockAudioOnGesture(); transitionToMainCard();
    await joinCall(); updateJoinButton();
  });

  els.disconnectBtn.addEventListener("click", disconnectRoom);

  // Accept incoming call — just dismiss the ring screen.
  // WebRTC offer is already firing automatically via room-state → createOffer().
  // DO NOT call startHostRoom() again here — state.joined is already true.
  els.acceptBtn.addEventListener("click", () => {
    hideIncomingCall();
  });

  // Decline incoming call
  els.declineBtn.addEventListener("click", () => {
    hideIncomingCall();
    // Optionally: leave room so guest knows
    if (state.socket && state.roomId)
      state.socket.emit("leave-room", { roomId: state.roomId });
    window.location.href = "/";
  });

  // Mute toggle
  els.muteBtn.addEventListener("click", () => {
    if (!state.localStream) return;
    const track = state.localStream.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    const muted = !track.enabled;
    els.muteIcon.textContent  = muted ? "🔇" : "🎤";
    els.muteLabel.textContent = muted ? "Unmute" : "Mute";
    els.muteBtn.classList.toggle("muted", muted);
  });

  // Speaker toggle
  els.speakerBtn.addEventListener("click", async () => {
    unlockAudioOnGesture(); state.speakerOn = !state.speakerOn; await applySpeakerMode();
  });

  // Handle push notification → page opened via notification click
  // The SW opens the room URL — app.js handles it normally via init()
  if (navigator.serviceWorker) {
    navigator.serviceWorker.addEventListener("message", (e) => {
      if (e.data?.type === "stop-ring") hideIncomingCall();
    });
  }
}

// ── Init ──────────────────────────────────────

async function init() {
  cacheEls();
  bindEvents();
  await registerSW();

  const roomId   = roomIdFromPath();
  const hostName = hostFromQuery();
  state.roomId   = roomId;
  state.hostName = hostName;
  state.roomUrl  = window.location.href;

  const savedName = localStorage.getItem("novacall_name");
  if (savedName) { state.name = savedName; els.homeName.value = savedName; }

  maybeShowiOSHint();

  if (!roomId) { showHome(); return; }

  showRoom();
  state.role = localStorage.getItem("novacall_host_room_id") === roomId ? "host" : "guest";
  els.roomLinkText.textContent = window.location.href;

  await loadIceServers();
  connectSocket();
  updateRoomTexts();

  if (state.role === "host") {
    setTimeout(() => {
      if (!state.manualDisconnect) startHostRoom().then(updateJoinButton);
    }, 200);
  } else {
    showGuestInviteCard(hostName);
    updatePill("blue", `${hostName} invited you`);
    els.roomHint.className   = "hint hint-blue";
    els.roomHint.textContent = `${hostName} is waiting. Tap Join Call to connect.`;
    els.bottomNote.textContent = "No sign-up or phone number needed.";
  }
}

window.addEventListener("DOMContentLoaded", init);
