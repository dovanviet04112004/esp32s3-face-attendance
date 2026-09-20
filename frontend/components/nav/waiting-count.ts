"use client";

import { useQuery } from "@tanstack/react-query";

import { api } from "@/lib/api";
import type { Role } from "@/lib/auth";

const DECIDERS: Role[] = ["MANAGER", "ADMIN", "HR"];

/** How many requests wait on this viewer, shared by every navigation surface. */
export function useWaitingCount(role: Role | null): number {
  const asked = useQuery({
    queryKey: ["requests", "inbox", "count"],
    enabled: role !== null && DECIDERS.includes(role),
    refetchInterval: 60_000,
    queryFn: async () => (await api.get<{ total: number }>("/requests/inbox?take=1")).data.total,
  });
  return asked.data ?? 0;
}
