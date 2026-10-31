const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");
const webpush = require("web-push");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

app.set("trust proxy", 1);
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ── VAPID setup ───────────────────────────────
// Keys are set via `fly secrets set` — never hardcoded
webpush.setVapidDetails(
  process.env.VAPID_EMAIL || "mailto:admin@novacall.app",
  process.env.VAPID_PUBLIC_KEY || "",
  process.env.VAPID_PRIVATE_KEY || ""
);

// ── In-memory stores ──────────────────────────
const rooms = new Map();
// roomId → push subscription of the HOST (so we can ring them when guest joins)
const pushSubs = new Map();

// ── ICE / TURN helpers ────────────────────────
function stunOnlyFallback() {
  return [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:global.stun.twilio.com:3478" },
  ];
}

function staticTurnFallback() {
  const url  = process.env.TURN_URL;
  const user = process.env.TURN_USER;
  const pass = process.env.TURN_PASS;
  if (!url || !user || !pass) return null;
  return [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:global.stun.twilio.com:3478" },
    { urls: url, username: user, credential: pass },
  ];
}

async function meteredFallback() {
  const apiKey   = process.env.TURN_API_KEY;
  const endpoint = process.env.TURN_ENDPOINT || "https://novacall.metered.live";
  if (!apiKey) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 7000);
  try {
    const res = await fetch(
      `${endpoint}/api/v1/turn/credentials?apiKey=${encodeURIComponent(apiKey)}`,
      { signal: controller.signal }
    );
    if (!res.ok) return null;
    const servers = await res.json();
    return Array.isArray(servers) && servers.length ? servers : null;
  } catch { return null; }
  finally { clearTimeout(timeout); }
}

// ── API: ICE servers ──────────────────────────
app.get("/api/ice", async (_req, res) => {
  const metered = await meteredFallback();
  if (metered) return res.json({ source: "metered", iceServers: metered });
  const staticTurn = staticTurnFallback();
  if (staticTurn) return res.json({ source: "static-turn", iceServers: staticTurn });
  return res.json({ source: "stun-only", iceServers: stunOnlyFallback() });
});

// ── API: VAPID public key (frontend needs it to subscribe) ──
app.get("/api/vapid-public-key", (_req, res) => {
  res.json({ key: process.env.VAPID_PUBLIC_KEY || "" });
});

// ── API: Save push subscription for a room's host ──
// Called by the host browser after it subscribes to push
app.post("/api/push-subscribe", (req, res) => {
  const { roomId, subscription } = req.body;
  if (!roomId || !subscription) return res.status(400).json({ error: "missing fields" });
  pushSubs.set(roomId, subscription);
  res.json({ ok: true });
});

// ── Health check ──────────────────────────────
app.get("/health", (_req, res) => res.json({ status: "ok" }));

// ── Room helpers ──────────────────────────────
function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      roomId,
      createdAt: Date.now(),
      host: null,
      guest: null,
      connected: false,
    });
  }
  return rooms.get(roomId);
}

function serializeRoom(room) {
  return {
    roomId: room.roomId,
    createdAt: room.createdAt,
    connected: room.connected,
    host:  room.host  ? { name: room.host.name,  online: room.host.online  } : null,
    guest: room.guest ? { name: room.guest.name, online: room.guest.online } : null,
  };
}

function activeTarget(room, socketId) {
  if (room.host  && room.host.id  === socketId && room.guest && room.guest.online) return room.guest.id;
  if (room.guest && room.guest.id === socketId && room.host  && room.host.online)  return room.host.id;
  return null;
}

// Send push notification to host when guest joins
async function notifyHostOfIncomingCall(room, guestName) {
  const sub = pushSubs.get(room.roomId);
  if (!sub) return; // host hasn't subscribed to push yet

  const payload = JSON.stringify({
    type: "incoming-call",
    roomId: room.roomId,
    guestName,
    hostName: room.host?.name || "You",
    url: `/room/${room.roomId}?host=${encodeURIComponent(room.host?.name || "")}`,
  });

  try {
    await webpush.sendNotification(sub, payload);
  } catch (err) {
    // Subscription expired or invalid — clean it up
    if (err.statusCode === 410 || err.statusCode === 404) {
      pushSubs.delete(room.roomId);
    }
  }
}

// ── Static files ──────────────────────────────
app.use(express.static(path.join(__dirname, "public")));
app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ── Socket.io signaling ───────────────────────
io.on("connection", (socket) => {
  socket.data.roomId = null;
  socket.data.role   = null;
  socket.data.name   = null;

  socket.on("create-room", ({ roomId, name }) => {
    if (!roomId || !name) return;
    const room = getRoom(roomId);
    room.host = { id: socket.id, name, online: true, joinedAt: Date.now() };
    room.connected = false;
    socket.data.roomId = roomId;
    socket.data.role   = "host";
    socket.data.name   = name;
    socket.join(roomId);
    io.to(roomId).emit("room-state", serializeRoom(room));
  });

  socket.on("join-room", ({ roomId, name }) => {
    if (!roomId || !name) return;
    const room = getRoom(roomId);
    room.guest = { id: socket.id, name, online: true, joinedAt: Date.now() };
    room.connected = false;
    socket.data.roomId = roomId;
    socket.data.role   = "guest";
    socket.data.name   = name;
    socket.join(roomId);
    io.to(roomId).emit("room-state", serializeRoom(room));
    io.to(roomId).emit("participant-joined", { roomId, role: "guest", name });
    // Ring the host via push notification if they're not in the tab
    notifyHostOfIncomingCall(room, name);
  });

  socket.on("signal", ({ roomId, description, candidate }) => {
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;
    const targetId = activeTarget(room, socket.id);
    if (!targetId) return;
    io.to(targetId).emit("signal", {
      roomId,
      description: description || null,
      candidate:   candidate   || null,
      from: socket.id,
    });
  });

  socket.on("peer-connected", ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    room.connected = true;
    io.to(roomId).emit("room-state", serializeRoom(room));
  });

  socket.on("leave-room", ({ roomId }) => {
    const targetRoomId = roomId || socket.data.roomId;
    if (!targetRoomId) return;
    const room = rooms.get(targetRoomId);
    if (!room) return;
    if (room.host  && room.host.id  === socket.id) room.host  = null;
    if (room.guest && room.guest.id === socket.id) room.guest = null;
    room.connected = false;
    socket.leave(targetRoomId);
    socket.data.roomId = null;
    socket.data.role   = null;
    socket.data.name   = null;
    if (!room.host && !room.guest) { rooms.delete(targetRoomId); return; }
    io.to(targetRoomId).emit("room-state", serializeRoom(room));
    io.to(targetRoomId).emit("participant-left", { roomId: targetRoomId });
  });

  socket.on("disconnect", () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;
    if (room.host  && room.host.id  === socket.id) room.host.online  = false;
    if (room.guest && room.guest.id === socket.id) room.guest.online = false;
    room.connected = false;
    if (!room.host && !room.guest) { rooms.delete(roomId); return; }
    io.to(roomId).emit("room-state", serializeRoom(room));
    io.to(roomId).emit("participant-left", { roomId });
  });
});

// Bind to 0.0.0.0 so Fly.io proxy can reach the server
server.listen(PORT, "0.0.0.0", () => {
  console.log(`NovaCall running on http://0.0.0.0:${PORT}`);
});
