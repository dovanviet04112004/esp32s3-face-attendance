"use client";

import { useMemo, useSyncExternalStore } from "react";

import { api } from "./api";
import { useSession } from "./auth";

export interface Filed {
  clientKey: string;
  path: string;
  body: Record<string, unknown>;
  filedAt: number;
  /** The account that filed it, the only one whose ticket may send it (KEHOACH 9.21.3 rule 2). */
  owner: string;
}

const kDatabase = "kiosk-outbox";
const kStore = "filed";
const kVersion = 1;
const kRetryMs = 30_000;

let ready: Promise<IDBDatabase> | null = null;
let held: Filed[] = [];
let sending = false;
const watchers = new Set<() => void>();

function announce(): void {
  for (const watcher of watchers) {
    watcher();
  }
}

function open(): Promise<IDBDatabase> {
  ready ??= new Promise((resolve, reject) => {
    const asked = indexedDB.open(kDatabase, kVersion);
    asked.onupgradeneeded = () => {
      asked.result.createObjectStore(kStore, { keyPath: "clientKey" });
    };
    asked.onsuccess = () => resolve(asked.result);
    asked.onerror = () => reject(asked.error);
  });
  return ready;
}

function run<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const asked = work(db.transaction(kStore, mode).objectStore(kStore));
        asked.onsuccess = () => resolve(asked.result);
        asked.onerror = () => reject(asked.error);
      }),
  );
}

async function reload(): Promise<void> {
  const all = (await run<Filed[]>("readonly", (store) => store.getAll())) ?? [];
  for (const nobodys of all.filter((one) => typeof one.owner !== "string")) {
    await run("readwrite", (store) => store.delete(nobodys.clientKey));
  }
  held = all.filter((one) => typeof one.owner === "string").sort((a, b) => a.filedAt - b.filedAt);
  announce();
}

/** Keep a request nobody could send. It carries its own key, so sending it
 *  twice lands on one row (KEHOACH 9.21.3 rule 2).
 */
export async function keep(entry: Omit<Filed, "owner">): Promise<void> {
  const owner = useSession.getState().userId;
  if (owner === null) {
    throw new Error("nobody is signed in to file this");
  }
  await run("readwrite", (store) => store.put({ ...entry, owner }));
  await reload();
}

/** Drop what one account left waiting on this device, once it has agreed to. */
export async function dropOwned(owner: string): Promise<void> {
  for (const entry of held.filter((one) => one.owner === owner)) {
    await run("readwrite", (store) => store.delete(entry.clientKey));
  }
  await reload();
}

async function drop(clientKey: string): Promise<void> {
  await run("readwrite", (store) => store.delete(clientKey));
  await reload();
}

/**
 * Try everything waiting, oldest first. A refusal the server actually made is
 * final, so it leaves the queue; only an unreachable server keeps a place.
 */
export async function flush(): Promise<void> {
  if (sending || typeof navigator === "undefined" || !navigator.onLine) {
    return;
  }
  sending = true;
  try {
    await reload();
    const me = useSession.getState().userId;
    for (const entry of held.filter((one) => one.owner === me)) {
      try {
        await api.post(entry.path, { ...entry.body, clientKey: entry.clientKey });
        await drop(entry.clientKey);
      } catch (fell) {
        if ((fell as { response?: unknown }).response !== undefined) {
          await drop(entry.clientKey);
          continue;
        }
        break;
      }
    }
  } finally {
    sending = false;
  }
}

let started = false;

/** Retry on the three moments a phone gets its signal back. */
export function startOutbox(): void {
  if (started || typeof window === "undefined") {
    return;
  }
  started = true;
  void reload();
  window.addEventListener("online", () => void flush());
  window.addEventListener("focus", () => void flush());
  window.setInterval(() => void flush(), kRetryMs);
  void flush();
}

function subscribe(watcher: () => void): () => void {
  watchers.add(watcher);
  return () => {
    watchers.delete(watcher);
  };
}

function snapshot(): Filed[] {
  return held;
}

const EMPTY: Filed[] = [];

/** What the signed-in account still has waiting to leave this device. */
export function useOutbox(): Filed[] {
  const all = useSyncExternalStore(subscribe, snapshot, () => EMPTY);
  const me = useSession((s) => s.userId);
  return useMemo(() => all.filter((one) => one.owner === me), [all, me]);
}
