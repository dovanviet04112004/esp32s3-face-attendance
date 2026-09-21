"use client";

import { useSyncExternalStore } from "react";

import { api } from "./api";

export interface Filed {
  clientKey: string;
  path: string;
  body: Record<string, unknown>;
  filedAt: number;
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
  held = ((await run<Filed[]>("readonly", (store) => store.getAll())) ?? []).sort(
    (a, b) => a.filedAt - b.filedAt,
  );
  announce();
}

/** Keep a request nobody could send. It carries its own key, so sending it
 *  twice lands on one row (KEHOACH 9.21.3 rule 2).
 */
export async function keep(entry: Filed): Promise<void> {
  await run("readwrite", (store) => store.put(entry));
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
    for (const entry of [...held]) {
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

/** What is still waiting to leave this device. */
export function useOutbox(): Filed[] {
  return useSyncExternalStore(subscribe, snapshot, () => EMPTY);
}
