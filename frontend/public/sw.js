// Bumping these is what evicts an older worker's store: activate keeps only
// the names listed here, so a name that never changes can never be evicted.
const SHELL = "shell-v2";
// One drawer per account, named READS:<sub>, since Cache Storage keys by URL alone (KEHOACH 4.7).
const READS = "reads-v3";
const KEEP = [SHELL];
const LOCAL = ["localhost", "127.0.0.1"];

function drawer(name) {
  return name.startsWith(`${READS}:`);
}

// Unverified on purpose: it only picks the drawer, and the api still checks the token.
function accountOf(request) {
  const header = request.headers.get("Authorization") || "";
  const body = header.startsWith("Bearer ") ? header.slice(7).split(".")[1] : "";
  try {
    return JSON.parse(atob(body.replace(/-/g, "+").replace(/_/g, "/"))).sub || null;
  } catch {
    return null;
  }
}

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(names.filter((n) => !KEEP.includes(n) && !drawer(n)).map((n) => caches.delete(n))),
      )
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
  const store = await caches.open(bucket);
  try {
    const fresh = await fetch(request);
    if (fresh.ok) {
      store.put(request, fresh.clone());
    }
    return fresh;
  } catch (fell) {
    const held = await store.match(request);
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
    const account = accountOf(request);
    // No account, no drawer: an anonymous read is never kept.
    if (account) {
      event.respondWith(networkFirst(request, `${READS}:${account}`));
    }
  }
});

// Signing out empties every drawer, so a shared browser hands nobody the last person's reads.
self.addEventListener("message", (event) => {
  if (event.data?.type !== "forget") {
    return;
  }
  event.waitUntil(caches.keys().then((names) => Promise.all(names.filter(drawer).map((n) => caches.delete(n)))));
});

// The payload carries a kind and references, so the wording is built here and
// a salary figure never reaches a lock screen (KEHOACH 9.21.4).
const SAYS = {
  vi: {
    REQUEST_DECIDED_true: "Đơn của bạn đã được duyệt",
    REQUEST_DECIDED_false: "Đơn của bạn bị từ chối",
    REQUEST_WAITING: "Có đơn chờ bạn duyệt",
    REQUEST_STALLED: "Đơn của bạn chưa ai quyết",
    PAYSLIP_ISSUED: "Phiếu lương kỳ này đã có",
    CONTRACT_ENDING: "Hợp đồng của bạn sắp hết hạn",
    DISPUTE_ANSWERED: "Khiếu nại phiếu lương của bạn đã có trả lời",
    title: "Chấm công",
  },
  en: {
    REQUEST_DECIDED_true: "Your request was approved",
    REQUEST_DECIDED_false: "Your request was turned down",
    REQUEST_WAITING: "A request is waiting on you",
    REQUEST_STALLED: "Your request has no decision yet",
    PAYSLIP_ISSUED: "This period's payslip is ready",
    CONTRACT_ENDING: "Your contract ends soon",
    DISPUTE_ANSWERED: "Your payslip dispute has an answer",
    title: "Attendance",
  },
};

const WHERE = {
  REQUEST_DECIDED: "/me/requests",
  REQUEST_WAITING: "/approvals",
  REQUEST_STALLED: "/me/requests",
  PAYSLIP_ISSUED: "/me/payslips",
  CONTRACT_ENDING: "/me",
  DISPUTE_ANSWERED: "/me/payslips",
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
      badge: "/badge.png",
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
