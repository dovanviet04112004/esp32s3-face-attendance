const SHELL = "shell-v1";
const READS = "reads-v1";
const KEEP = [SHELL, READS];

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
  if (url.origin === self.location.origin && url.pathname.startsWith("/_next/static/")) {
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
