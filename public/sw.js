// ─────────────────────────────────────────────
//  NovaCall Service Worker
//  Handles: push notifications, incoming call UI,
//           ring sound, offline caching
// ─────────────────────────────────────────────

const CACHE = "novacall-v1";
const PRECACHE = ["/", "/index.html", "/styles.css", "/app.js", "/ring.mp3"];

// ── Install: precache shell ───────────────────
self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(PRECACHE).catch(() => {}))
  );
  self.skipWaiting();
});

// ── Activate: clean old caches ────────────────
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// ── Fetch: serve from cache, fallback to network ──
self.addEventListener("fetch", (e) => {
  // Only cache GET requests for our own origin
  if (e.request.method !== "GET") return;
  if (!e.request.url.startsWith(self.location.origin)) return;
  // Don't cache API or socket calls
  if (e.request.url.includes("/api/") || e.request.url.includes("/socket.io/")) return;

  e.respondWith(
    caches.match(e.request).then((cached) => cached || fetch(e.request))
  );
});

// ── Push: incoming call notification ─────────
self.addEventListener("push", (e) => {
  let data = {};
  try { data = e.data?.json() || {}; } catch {}

  if (data.type !== "incoming-call") return;

  const guestName = data.guestName || "Someone";
  const hostName  = data.hostName  || "you";
  const roomUrl   = data.url       || "/";

  // Store call data so the notificationclick handler can use it
  e.waitUntil(
    self.registration.showNotification(`📞 Incoming call`, {
      body: `${guestName} is calling ${hostName}`,
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      tag: `incoming-call-${data.roomId}`,   // replaces previous notification for same room
      renotify: true,
      requireInteraction: true,              // stays on screen until dismissed
      vibrate: [400, 200, 400, 200, 400],    // Android ring pattern
      data: { roomUrl, guestName, roomId: data.roomId },
      actions: [
        { action: "accept", title: "✅ Accept" },
        { action: "decline", title: "❌ Decline" },
      ],
    })
  );
});

// ── Notification click: open call or dismiss ──
self.addEventListener("notificationclick", (e) => {
  e.notification.close();

  const { roomUrl, action } = { roomUrl: e.notification.data?.roomUrl, action: e.action };

  if (action === "decline") return; // just dismiss

  // Accept or tap body → open/focus the room
  e.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      // If the room tab is already open, focus it
      const existing = list.find((c) => c.url.includes(roomUrl));
      if (existing) return existing.focus();
      // Otherwise open a new tab
      return clients.openWindow(roomUrl);
    })
  );
});

// ── Message: ring control from page ──────────
// The page posts { type: "stop-ring" } when call connects or user taps decline
self.addEventListener("message", (e) => {
  if (e.data?.type === "stop-ring") {
    self.registration.getNotifications().then((notes) => {
      notes.forEach((n) => n.close());
    });
  }
});
