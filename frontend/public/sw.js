// Bumping these is what evicts an older worker's store: activate keeps only
// the names listed here, so a name that never changes can never be evicted.
const SHELL = "shell-v3";
// One drawer per account, named READS:<sub>, since Cache Storage keys by URL alone (KEHOACH 4.7).
const READS = "reads-v4";
const KEEP = [SHELL];

importScripts("/sw-words.js");
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

// The drawer holds what a page reads, JSON; a download never lands in it (KEHOACH 7.2).
// Content-Type is one of the few headers a cross-origin answer shows to a worker.
function keepable(response) {
  return response.ok && /^application\/json/i.test(response.headers.get("Content-Type") || "");
}

async function networkFirst(request, bucket, key = request) {
  const store = await caches.open(bucket);
  try {
    const fresh = await fetch(request);
    if (keepable(fresh)) {
      store.put(key, fresh.clone());
    }
    return fresh;
  } catch (fell) {
    const held = await store.match(key);
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
  // A dev build reuses chunk names: keeping the first copy pins the app to the first build it saw.
  const addressed = !LOCAL.includes(url.hostname);
  if (addressed && url.origin === self.location.origin && url.pathname.startsWith("/_next/static/")) {
    event.respondWith(cacheFirst(request));
    return;
  }
  // Keyed without the query, so a setup ticket in the address never reaches Cache Storage.
  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request, SHELL, `${url.origin}${url.pathname}`));
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

// The manifest's short_name: the system's name reads the same in both languages (KEHOACH 9.21.6).
const APP_NAME = "Nhân Lực";

function wording(body) {
  const words = self.SW_WORDS[body.locale] || self.SW_WORDS.vi;
  if (body.count > 1) {
    return words.gathered.replace("{count}", String(body.count));
  }
  return words[body.kind] || words.other;
}

self.addEventListener("push", (event) => {
  let body = {};
  try {
    body = event.data ? event.data.json() : {};
  } catch (fell) {
    body = {};
  }
  const tag = body.tag || body.kind || "notice";
  event.waitUntil(
    self.registration.showNotification(APP_NAME, {
      body: wording(body),
      icon: "/icon-192.png",
      badge: "/badge.png",
      tag,
      renotify: body.renotify === true,
      data: { id: body.id || null, locale: body.locale === "en" ? "en" : "vi" },
    }),
  );
});

// A window already open is brought forward and moved, so a tap never stacks a second copy of the app.
async function reopen(target) {
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const held = windows.find((one) => one.url === target) || windows[0];
  if (!held) {
    return self.clients.openWindow(target);
  }
  const shown = await held.focus();
  // navigate() refuses a window this worker does not control; that one is still in front.
  return shown.url === target ? shown : shown.navigate(target).catch(() => shown);
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const held = event.notification.data || {};
  const path = held.id ? `/notifications/open/${held.id}` : "";
  event.waitUntil(reopen(new URL(`/${held.locale || "vi"}${path}`, self.location.origin).href));
});
