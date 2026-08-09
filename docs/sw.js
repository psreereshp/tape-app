self.addEventListener("push", (event) => {
  let payload = { title: "Swing Trade Analyst", body: "A watched position moved." };
  try {
    if (event.data) payload = event.data.json();
  } catch {
    // ignore malformed payloads
  }

  const data = payload.data || {};
  event.waitUntil(
    self.registration.showNotification(payload.title || "Swing Trade Analyst", {
      body: payload.body || "",
      icon: "icons/icon-192.png",
      badge: "icons/icon-192.png",
      tag: data.ticker ? `watch-${data.ticker}` : undefined,
      data,
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const url = data.ticker ? `./?trigger=${encodeURIComponent(data.ticker)}` : "./";

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ("focus" in client) {
          client.postMessage({ type: "watch-trigger-click", data });
          return client.focus();
        }
      }
      return self.clients.openWindow(url);
    })
  );
});
