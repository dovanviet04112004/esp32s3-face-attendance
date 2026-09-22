"use client";

import { useQueries } from "@tanstack/react-query";

import { api } from "@/lib/api";
import type { Role } from "@/lib/auth";

export const REQUEST_DECIDERS: Role[] = ["MANAGER", "ADMIN", "HR", "PAYROLL"];
export const ADVANCE_DECIDERS: Role[] = ["ADMIN", "PAYROLL", "HR", "MANAGER"];
export const ADVANCE_PAYERS: Role[] = ["ADMIN", "PAYROLL"];
export const DEPENDENT_DECIDERS: Role[] = ["ADMIN", "PAYROLL"];
export const DISPUTE_ANSWERERS: Role[] = ["ADMIN", "PAYROLL"];
export const LETTER_DESK: Role[] = ["ADMIN", "HR", "PAYROLL"];
export const PROFILE_DESK: Role[] = ["ADMIN", "HR"];

interface Queue {
  key: string[];
  path: string;
  roles: Role[];
}

export const WAITING_POLL_MS = 60_000;

// Each key sits under the one a decision drops, so acting takes the badge too.
const QUEUES: Queue[] = [
  { key: ["requests", "waiting-count"], path: "/requests/inbox?take=1", roles: REQUEST_DECIDERS },
  { key: ["advances", "waiting-count", "pending"], path: "/advances?state=PENDING", roles: ADVANCE_DECIDERS },
  { key: ["advances", "waiting-count", "approved"], path: "/advances?state=APPROVED", roles: ADVANCE_PAYERS },
  { key: ["dependents", "waiting-count"], path: "/dependents?state=PENDING", roles: DEPENDENT_DECIDERS },
  { key: ["payslip-disputes", "waiting-count"], path: "/payslip-disputes?state=OPEN", roles: DISPUTE_ANSWERERS },
  { key: ["certificates", "waiting-count"], path: "/certificates?state=REQUESTED", roles: LETTER_DESK },
  { key: ["profile-changes", "waiting-count"], path: "/profile-changes?state=PENDING", roles: PROFILE_DESK },
];

function countOf(answer: unknown): number {
  if (Array.isArray(answer)) {
    return answer.length;
  }
  const page = answer as { total?: number; rows?: unknown[] };
  return page.total ?? page.rows?.length ?? 0;
}

/** How much waits on this viewer across every queue of the inbox, shared by
 *  every navigation surface (KEHOACH 9.15).
 */
export function useWaitingCount(role: Role | null): number {
  const asked = useQueries({
    queries: QUEUES.map((queue) => ({
      queryKey: queue.key,
      enabled: role !== null && queue.roles.includes(role),
      refetchInterval: WAITING_POLL_MS,
      queryFn: async () => countOf((await api.get(queue.path)).data),
    })),
  });
  return asked.reduce((total, one) => total + (one.data ?? 0), 0);
}
