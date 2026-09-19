"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";

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
  attendance: ["attendance"],
  event: ["devices"],
  device: ["devices"],
};

const KEEP = 50;

/** Listen to the gateway for as long as a component is mounted.
 *  Arriving news both fills the returned list and drops the cached query it
 *  contradicts, so a page reads the same whether or not the socket is up.
 */
export function useFeed(): { status: FeedStatus; items: FeedItem[] } {
  const cache = useQueryClient();
  const [status, setStatus] = useState<FeedStatus>("reconnecting");
  const [items, setItems] = useState<FeedItem[]>([]);
  const counted = useRef(0);

  useEffect(() => {
    const socket: Socket = io(`${env.NEXT_PUBLIC_WS_URL}/feed`, {
      withCredentials: true,
      transports: ["websocket"],
    });

    socket.on("connect", () => setStatus("live"));
    socket.on("disconnect", () => setStatus("reconnecting"));
    socket.io.on("reconnect_failed", () => setStatus("dropped"));

    for (const feed of FEEDS) {
      socket.on(feed, (body: Record<string, unknown>) => {
        counted.current += 1;
        const arrived = { id: counted.current, feed, body };
        setItems((held) => [arrived, ...held].slice(0, KEEP));
        for (const key of REFRESH[feed]) {
          void cache.invalidateQueries({ queryKey: [key] });
        }
      });
    }

    return () => {
      socket.close();
    };
  }, [cache]);

  return { status, items };
}
