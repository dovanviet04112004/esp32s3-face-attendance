// Bumping these is what evicts an older worker's store: activate keeps only
// the names listed here, so a name that never changes can never be evicted.
const SHELL = "shell-v2";
const READS = "reads-v2";
const KEEP = [SHELL, READS];
const LOCAL = ["localhost", "127.0.0.1"];

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((n) => !KEEP.includes(n)).map((n) => caches.delete(n))))
      .then(() => self.clients.claim()),
  );
});

async function cacheFirst(request) {
  const held = await caches.match(request);
  if (held) {
    return held;
  }
  const fresh = await fetch(request);
  const store = await caches.open(SHELL);
  store.put(request, fresh.clone());
  return fresh;
}

async function networkFirst(request, bucket) {
  try {
    const fresh = await fetch(request);
    if (fresh.ok) {
      const store = await caches.open(bucket);
      store.put(request, fresh.clone());
    }
    return fresh;
  } catch (fell) {
    const held = await caches.match(request);
    if (held) {
      return held;
    }
    throw fell;
  }
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  // A filed request must queue and say so, never replay an old answer.
  if (request.method !== "GET") {
    return;
  }
  const url = new URL(request.url);
  // A dev build reuses chunk names, so holding the first copy of one pins the
  // whole app to the first build the browser ever saw.
  const addressed = !LOCAL.includes(url.hostname);
  if (addressed && url.origin === self.location.origin && url.pathname.startsWith("/_next/static/")) {
    event.respondWith(cacheFirst(request));
    return;
  }
  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request, SHELL));
    return;
  }
  if (url.origin !== self.location.origin) {
    event.respondWith(networkFirst(request, READS));
  }
});

// The payload carries a kind and references, so the wording is built here and
// a salary figure never reaches a lock screen (KEHOACH 9.21.4).
const SAYS = {
  vi: {
    REQUEST_DECIDED_true: "Đơn của bạn đã được duyệt",
    REQUEST_DECIDED_false: "Đơn của bạn bị từ chối",
    REQUEST_WAITING: "Có đơn chờ bạn duyệt",
    PAYSLIP_ISSUED: "Phiếu lương kỳ này đã có",
    CONTRACT_ENDING: "Hợp đồng của bạn sắp hết hạn",
    title: "Chấm công",
  },
  en: {
    REQUEST_DECIDED_true: "Your request was approved",
    REQUEST_DECIDED_false: "Your request was turned down",
    REQUEST_WAITING: "A request is waiting on you",
    PAYSLIP_ISSUED: "This period's payslip is ready",
    CONTRACT_ENDING: "Your contract ends soon",
    title: "Attendance",
  },
};

const WHERE = {
  REQUEST_DECIDED: "/me/requests",
  REQUEST_WAITING: "/approvals",
  PAYSLIP_ISSUED: "/me/payslips",
  CONTRACT_ENDING: "/me",
};

// The worker's scope is "/", so it cannot read a locale off the url; the
// payload carries it, the same way the payslip mail does.
function tableFor(body) {
  return SAYS[body.locale] || SAYS.vi;
}

function wording(body) {
  const table = tableFor(body);
  if (body.kind === "REQUEST_DECIDED") {
    return table[`REQUEST_DECIDED_${body.approved === true}`];
  }
  return table[body.kind] || table.title;
}

self.addEventListener("push", (event) => {
  let body = {};
  try {
    body = event.data ? event.data.json() : {};
  } catch (fell) {
    body = {};
  }
  const table = tableFor(body);
  event.waitUntil(
    self.registration.showNotification(table.title, {
      body: wording(body),
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      tag: body.kind,
      data: { path: WHERE[body.kind] || "/me", locale: body.locale || "vi" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const held = event.notification.data || {};
  const path = held.path || "/me";
  const locale = held.locale || "vi";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      for (const one of windows) {
        if (one.url.includes(path)) {
          return one.focus();
        }
      }
      return self.clients.openWindow(`/${locale}${path}`);
    }),
  );
});
