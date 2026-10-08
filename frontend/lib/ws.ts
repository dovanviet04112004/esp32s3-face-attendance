"use client";

import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { io, type Socket } from "socket.io-client";
import { create } from "zustand";

import { reopenSession } from "./api";
import { useSession, whenSignedOut } from "./auth";
import { env } from "./env";

/** The kiosk's own news, which pages list as it arrives. */
export type ListedFeed = "attendance" | "event" | "device";

export type FeedName = ListedFeed | "change" | "notice";

export type FeedStatus = "live" | "reconnecting" | "dropped";

/** A punch of the reader's own that just arrived, as the notice feed tells it (KEHOACH 9.21.4). */
export interface PunchHeard {
  ts: string;
  deviceId: string;
  delayed: boolean;
}

export interface FeedItem {
  id: number;
  feed: ListedFeed;
  body: Record<string, unknown>;
  /** Epoch ms the browser heard it, for news that carries no ts of its own. */
  heardAt: number;
}

const LISTED: readonly FeedName[] = ["attendance", "event", "device"];

const FEEDS: FeedName[] = [...LISTED, "change", "notice"];

/** What each feed makes stale, so a card is not left showing an old number. */
const REFRESH: Record<FeedName, string[]> = {
  attendance: ["attendance", "reports"],
  event: ["devices", "releases"],
  device: ["devices", "releases"],
  change: [],
  notice: ["notifications"],
};

// The list a queue's work shows in; an item's key starts with its queue (KEHOACH 9.21.4).
const QUEUE_LISTS: Record<string, string[]> = {
  requests: ["requests"],
  "advances-to-decide": ["advances"],
  "advances-to-pay": ["advances"],
  certificates: ["certificates"],
  "profile-changes": ["profile-changes"],
  disputes: ["payslip-disputes"],
  dependents: ["dependents"],
  attendance: ["timesheet"],
};

// What a group's news makes stale beyond the bell itself.
const CATEGORY_LISTS: Record<string, string[]> = {
  REQUESTS: ["requests", "advances", "certificates", "profile-changes", "dependents", "payslip-disputes"],
  PAY: ["payslips", "payslip-disputes", "advances", "tax-year"],
  PEOPLE: ["contracts"],
  ATTENDANCE: ["timesheet", "me"],
};

// One notice can reach five hundred browsers at once; each asks again after a random wait.
const NOTICE_SPREAD_MS = 3000;

/** What a write under one route word makes stale beyond its own key (KEHOACH 9.4). */
const SPILLS: Record<string, string[]> = {
  requests: ["leave-balances", "timesheet", "attendance", "advances"],
  "leave-types": ["leave-balances"],
  shifts: ["me", "employees"],
  documents: ["me"],
  timesheet: ["attendance", "reports"],
  "payroll-periods": ["payroll-runs", "payslips"],
  "payroll-runs": ["payroll-periods", "payslips"],
  "payslip-disputes": ["payslips", "requests"],
  dependents: ["tax-year", "requests"],
  "profile-changes": ["employees", "requests"],
  advances: ["requests"],
  certificates: ["requests"],
  employees: ["search"],
  import: ["users", "compensation", "shifts", "enrollments", "me"],
  placement: ["users", "requests", "departments", "job-titles", "legal-entities"],
  logins: ["users"],
  users: ["employees"],
  onboard: ["checklist", "checklists"],
  offboard: ["checklist", "checklists", "assets", "contracts", "users", "enrollments"],
  "checklist-tasks": ["checklist", "checklists"],
  checklists: ["checklist"],
  org: ["employees", "departments"],
  departments: ["employees"],
  "job-titles": ["employees"],
  "legal-entities": ["departments"],
  "personnel-file-types": ["personnel-files"],
  contracts: ["reports"],
  "biometric-consents": ["enrollments", "employees"],
  enrollments: ["devices", "employees"],
  releases: ["devices"],
  devices: ["releases"],
};

// A batch write lands as one message per row; one refetch answers them all.
const GATHER_MS = 300;

// Cut twice this close together is a refusal, not a ticket running out (KEHOACH 9.4).
const RENEW_GAP_MS = 30_000;

const KEEP = 50;

interface Feed {
  status: FeedStatus;
  items: FeedItem[];
  counted: number;
  setStatus: (status: FeedStatus) => void;
  push: (feed: ListedFeed, body: Record<string, unknown>) => void;
}

function emptyFeed(): Pick<Feed, "status" | "items" | "counted"> {
  return { status: "reconnecting", items: [], counted: 0 };
}

const useStore = create<Feed>((set) => ({
  ...emptyFeed(),
  setStatus: (status) => set({ status }),
  push: (feed, body) =>
    set((held) => {
      const id = held.counted + 1;
      return { counted: id, items: [{ id, feed, body, heardAt: Date.now() }, ...held.items].slice(0, KEEP) };
    }),
}));

whenSignedOut(() => useStore.setState(emptyFeed()));

// A heartbeat only refreshes the cache; listed, one kiosk beating every 30 s buries every punch.
function listed(feed: FeedName, body: Record<string, unknown>): feed is ListedFeed {
  return LISTED.includes(feed) && (feed !== "device" || "online" in body || "status" in body);
}

function staleKeys(feed: FeedName, body: Record<string, unknown>): string[] {
  if (feed !== "change" || !Array.isArray(body.resources)) {
    return REFRESH[feed];
  }
  const words = body.resources.filter((word): word is string => typeof word === "string");
  return words.flatMap((word) => [word, ...(SPILLS[word] ?? [])]);
}

function noticeKeys(body: Record<string, unknown>): string[] {
  if (body.op === "item" && typeof body.key === "string") {
    return [...REFRESH.notice, ...(QUEUE_LISTS[body.key.split(":")[0]] ?? [])];
  }
  if (body.op === "new" && typeof body.category === "string") {
    return [...REFRESH.notice, ...(CATEGORY_LISTS[body.category] ?? [])];
  }
  return REFRESH.notice;
}

// Work that closed needs no push left on this device's lock screen; its tag is the item's key (KEHOACH 9.21.4).
function dropShown(tag: string): void {
  void navigator.serviceWorker?.ready
    .then((registration) => registration.getNotifications({ tag }))
    .then((shown) => shown.forEach((one) => one.close()));
}

function gatherer(cache: QueryClient): { add: (keys: string[]) => void; stop: () => void } {
  const due = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    timer = undefined;
    for (const key of due) {
      void cache.invalidateQueries({ queryKey: [key] });
    }
    due.clear();
  };
  return {
    add: (keys) => {
      keys.forEach((key) => due.add(key));
      timer ??= setTimeout(flush, GATHER_MS);
    },
    stop: () => clearTimeout(timer),
  };
}

/** Hold the one socket a browser needs. The shell mounts it, so news drops the
 *  cache it contradicts wherever the reader happens to be standing.
 *  @param onPunch how the shell says a punch of the reader's own arrived; the feed only sends it while they want it
 */
export function useFeedConnection(onPunch?: (punch: PunchHeard) => void): void {
  const cache = useQueryClient();
  // Keyed on the account, so a renewal that brings another account opens a socket of its own.
  const reader = useSession((s) => (s.accessToken !== null ? s.userId : null));
  const toldOf = useRef(onPunch);
  useEffect(() => {
    toldOf.current = onPunch;
  });

  useEffect(() => {
    if (reader === null) {
      return;
    }
    const socket: Socket = io(`${env.NEXT_PUBLIC_WS_URL}/feed`, {
      withCredentials: true,
      transports: ["websocket"],
      auth: (hand) => hand({ token: useSession.getState().accessToken }),
    });
    const stale = gatherer(cache);
    const spreading = new Set<ReturnType<typeof setTimeout>>();
    let joined = false;
    let closed = false;
    let renewedAt = 0;

    const { setStatus, push } = useStore.getState();
    socket.on("connect", () => {
      setStatus("live");
      // News sent while the socket is down never arrives (KEHOACH 9.4).
      if (joined) {
        void cache.invalidateQueries();
      }
      joined = true;
    });
    socket.on("disconnect", (reason) => {
      setStatus("reconnecting");
      // socket.io leaves a socket the server cut down, and an expired ticket is cut.
      if (reason !== "io server disconnect") {
        return;
      }
      if (Date.now() - renewedAt < RENEW_GAP_MS) {
        setStatus("dropped");
        return;
      }
      renewedAt = Date.now();
      void reopenSession().then((token) => {
        if (token && !closed) {
          socket.connect();
        }
      });
    });
    socket.io.on("reconnect_failed", () => setStatus("dropped"));

    for (const feed of FEEDS) {
      socket.on(feed, (body: Record<string, unknown>) => {
        if (listed(feed, body)) {
          push(feed, body);
        }
        if (feed !== "notice") {
          stale.add(staleKeys(feed, body));
          return;
        }
        if (body.op === "punch" && typeof body.ts === "string") {
          toldOf.current?.({ ts: body.ts, deviceId: String(body.deviceId ?? ""), delayed: body.delayed === true });
          return;
        }
        if (body.op === "item" && body.state !== "OPEN" && typeof body.key === "string") {
          dropShown(body.key);
        }
        const timer = setTimeout(() => {
          spreading.delete(timer);
          stale.add(noticeKeys(body));
        }, Math.random() * NOTICE_SPREAD_MS);
        spreading.add(timer);
      });
    }

    return () => {
      closed = true;
      stale.stop();
      spreading.forEach(clearTimeout);
      socket.close();
    };
  }, [cache, reader]);
}

/** Read what has arrived. A page that only wants fresh data needs none of
 *  this: the shell has already dropped the cache the news contradicts.
 */
export function useFeed(): { status: FeedStatus; items: FeedItem[] } {
  const status = useStore((s) => s.status);
  const items = useStore((s) => s.items);
  return { status, items };
}
