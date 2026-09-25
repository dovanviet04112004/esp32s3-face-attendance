"use client";

import { useQuery } from "@tanstack/react-query";

import { api } from "@/lib/api";
import type { Role } from "@/lib/auth";

export const REQUEST_DECIDERS: Role[] = ["MANAGER", "ADMIN", "HR", "PAYROLL"];
export const ADVANCE_DECIDERS: Role[] = ["ADMIN", "HR"];
export const ADVANCE_PAYERS: Role[] = ["ADMIN", "PAYROLL"];
export const DEPENDENT_DECIDERS: Role[] = ["ADMIN", "PAYROLL"];
export const DISPUTE_ANSWERERS: Role[] = ["ADMIN", "PAYROLL"];
export const LETTER_DESK: Role[] = ["ADMIN", "HR", "PAYROLL"];
export const PROFILE_DESK: Role[] = ["ADMIN", "HR"];

export const WAITING_POLL_MS = 60_000;

export interface InboxCounts {
  requests: number;
  disputes: number;
  certificates: number;
  profileChanges: number;
  dependents: number;
  advancesToDecide: number;
  advancesToPay: number;
}

export type Queue = keyof InboxCounts;

export const QUEUE_ROLES: Record<Queue, Role[]> = {
  requests: REQUEST_DECIDERS,
  disputes: DISPUTE_ANSWERERS,
  certificates: LETTER_DESK,
  profileChanges: PROFILE_DESK,
  dependents: DEPENDENT_DECIDERS,
  advancesToDecide: ADVANCE_DECIDERS,
  advancesToPay: ADVANCE_PAYERS,
};

// Under "requests", so a decision anywhere in the inbox that drops that key takes the badge with it.
export const COUNTS_KEY = ["requests", "inbox", "counts"];

/** The per-queue numbers behind the badge; the inbox tabs read the same query. */
export function useInboxCounts(role: Role | null) {
  const decides = role !== null && Object.values(QUEUE_ROLES).some((roles) => roles.includes(role));
  return useQuery({
    queryKey: COUNTS_KEY,
    enabled: decides,
    refetchInterval: WAITING_POLL_MS,
    queryFn: async () => (await api.get<InboxCounts>("/requests/inbox/counts")).data,
  });
}

/** How much waits on this viewer across every queue of the inbox, for every navigation surface (KEHOACH 9.15). */
export function useWaitingCount(role: Role | null): number {
  const counts = useInboxCounts(role);
  return counts.data ? Object.values(counts.data).reduce((total, one) => total + one, 0) : 0;
}
