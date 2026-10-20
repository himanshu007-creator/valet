// Installability + push notifications only — deliberately NOT offline-first for API/WS data,
// job status must always be live. Only the static app shell gets cached.
const CACHE = "valet-shell-v1";
const SHELL = ["/", "/manifest.json", "/icon-192.png", "/icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  // API calls and WS upgrades always go to the network — never served stale.
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/ws/") || url.pathname.startsWith("/desk/") || url.pathname.startsWith("/auth/")) return;
  if (event.request.method !== "GET") return;
  event.respondWith(caches.match(event.request).then((cached) => cached ?? fetch(event.request)));
});

self.addEventListener("push", (event) => {
  const data = event.data?.json() ?? { title: "VALET", body: "" };
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      data: { ticketId: data.ticketId },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const ticketId = event.notification.data?.ticketId;
  const url = ticketId ? `/app?job=${encodeURIComponent(ticketId)}` : "/app";
  event.waitUntil(self.clients.openWindow(url));
});
