self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", event => {
  let data = {};

  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }

  const title = data.title || "FAWAZ AI BOT";

  const options = {
    body: data.body || "فرصة تداول جديدة",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    data: {
      signalId: data.signalId || "",
      url: data.url || "/"
    },
    actions: [
      {
        action: "approve",
        title: "✅ قبول"
      },
      {
        action: "reject",
        title: "❌ رفض"
      }
    ]
  };

  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

self.addEventListener("notificationclick", event => {
  event.notification.close();

  const signalId = event.notification.data?.signalId || "";

  if (
    event.action === "approve" ||
    event.action === "reject"
  ) {
    event.waitUntil(
      fetch("/api/approve", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          signalId,
          action: event.action
        })
      })
    );

    return;
  }

  event.waitUntil(
    clients.openWindow(
      event.notification.data?.url || "/"
    )
  );
});
