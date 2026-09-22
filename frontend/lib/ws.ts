"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { io, type Socket } from "socket.io-client";
import { create } from "zustand";

import { useSession } from "./auth";
import { env } from "./env";

export type FeedName = "attendance" | "event" | "device";

export type FeedStatus = "live" | "reconnecting" | "dropped";

export interface FeedItem {
  id: number;
  feed: FeedName;
  body: Record<string, unknown>;
}

const FEEDS: FeedName[] = ["attendance", "event", "device"];

/** What each feed makes stale, so a card is not left showing an old number. */
const REFRESH: Record<FeedName, string[]> = {
  attendance: ["attendance", "timesheet", "reports"],
  event: ["devices"],
  device: ["devices"],
};

const KEEP = 50;

interface Feed {
  status: FeedStatus;
  items: FeedItem[];
  counted: number;
  setStatus: (status: FeedStatus) => void;
  push: (feed: FeedName, body: Record<string, unknown>) => void;
}

const useStore = create<Feed>((set) => ({
  status: "reconnecting",
  items: [],
  counted: 0,
  setStatus: (status) => set({ status }),
  push: (feed, body) =>
    set((held) => {
      const id = held.counted + 1;
      return { counted: id, items: [{ id, feed, body }, ...held.items].slice(0, KEEP) };
    }),
}));

/** Hold the one socket a browser needs. The shell mounts it, so news drops the
 *  cache it contradicts wherever the reader happens to be standing.
 */
export function useFeedConnection(): void {
  const cache = useQueryClient();
  const signedIn = useSession((s) => s.accessToken !== null);

  useEffect(() => {
    if (!signedIn) {
      return;
    }
    const socket: Socket = io(`${env.NEXT_PUBLIC_WS_URL}/feed`, {
      withCredentials: true,
      transports: ["websocket"],
      auth: (hand) => hand({ token: useSession.getState().accessToken }),
    });

    const { setStatus, push } = useStore.getState();
    socket.on("connect", () => setStatus("live"));
    socket.on("disconnect", () => setStatus("reconnecting"));
    socket.io.on("reconnect_failed", () => setStatus("dropped"));

    for (const feed of FEEDS) {
      socket.on(feed, (body: Record<string, unknown>) => {
        push(feed, body);
        for (const key of REFRESH[feed]) {
          void cache.invalidateQueries({ queryKey: [key] });
        }
      });
    }

    return () => {
      socket.close();
    };
  }, [cache, signedIn]);
}

/** Read what has arrived. A page that only wants fresh data needs none of
 *  this: the shell has already dropped the cache the news contradicts.
 */
export function useFeed(): { status: FeedStatus; items: FeedItem[] } {
  const status = useStore((s) => s.status);
  const items = useStore((s) => s.items);
  return { status, items };
}
