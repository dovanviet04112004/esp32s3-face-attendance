import type { NoticeKind, NoticeLevel, NoticeQueue, Role } from "@prisma/client";

/** The group a kind shows under in the bell and in Settings; read off this table, never stored (KEHOACH 9.21.4). */
export type NoticeCategory = "REQUESTS" | "PAY" | "PEOPLE" | "ATTENDANCE" | "SYSTEM";

export type FactType = "number" | "boolean" | "string" | "day";

export type OfferedChannel = "IN_APP" | "PUSH";

/** Kinds that are work a group shares; every other kind is news for one person (KEHOACH 9.21.4). */
export type ItemKind = "REQUEST_WAITING" | "CONTRACT_DUE" | "PROBATION_DUE" | "BACKUP_ALERT" | "KIOSK_ALERT";

export type NewsKind = Exclude<NoticeKind, ItemKind>;

export function kebab(name: string): string {
  return name.toLowerCase().replaceAll("_", "-");
}

/** The whole days of waiting at which an inbox queue's work speaks again (KEHOACH 9.17 item 12). */
export const QUEUE_MARKS: Partial<Record<NoticeQueue, readonly number[]>> = {
  REQUESTS: [3, 7, 14],
  ADVANCES_TO_DECIDE: [3, 7],
  ADVANCES_TO_PAY: [3, 7],
  CERTIFICATES: [3, 7],
  PROFILE_CHANGES: [3, 7],
  DEPENDENTS: [3, 7],
};

export const DUE_SOON_DAYS = 1;

/** Days left at which work against a date opens and then speaks again, the first mark opening it (KEHOACH 9.18 items 1-2). */
export const DUE_MARKS: Partial<Record<NoticeQueue, readonly number[]>> = {
  CONTRACTS_DUE: [30, 15, 7],
  PROBATION_DUE: [7, 3, 1],
};

export const DUE_WARNING: Partial<Record<NoticeQueue, number>> = {
  CONTRACTS_DUE: 7,
};

/** Roles whose login opens the approvals inbox (KEHOACH 9.15). */
export const INBOX_ROLES: readonly Role[] = ["ADMIN", "HR", "PAYROLL", "MANAGER"];

export interface KindRule {
  category: NoticeCategory;
  level: NoticeLevel;
  /** "self": the person the notice is about, through their own login; a role list: whoever the work waits on. */
  receivers: "self" | readonly Role[];
  /** Work a group shares, with a state of its own; otherwise news for one person. */
  item: boolean;
  defaults: Record<OfferedChannel, boolean>;
  facts: Readonly<Record<string, FactType>>;
}

/** One row per kind; a kind missing here does not compile (KEHOACH 9.21.4, 4.9). */
export const NOTICE_KINDS: Record<NoticeKind, KindRule> = {
  REQUEST_WAITING: {
    category: "REQUESTS",
    level: "ACTION",
    receivers: INBOX_ROLES,
    item: true,
    defaults: { IN_APP: true, PUSH: true },
    facts: { daysWaited: "number" },
  },
  REQUEST_DECIDED: {
    category: "REQUESTS",
    level: "INFO",
    receivers: "self",
    item: false,
    defaults: { IN_APP: true, PUSH: true },
    facts: { outcome: "string" },
  },
  REQUEST_STALLED: {
    category: "REQUESTS",
    level: "INFO",
    receivers: "self",
    item: false,
    defaults: { IN_APP: true, PUSH: true },
    facts: { daysWaited: "number" },
  },
  PAYSLIP_ISSUED: {
    category: "PAY",
    level: "INFO",
    receivers: "self",
    item: false,
    defaults: { IN_APP: true, PUSH: true },
    facts: {},
  },
  DISPUTE_ANSWERED: {
    category: "PAY",
    level: "INFO",
    receivers: "self",
    item: false,
    defaults: { IN_APP: true, PUSH: true },
    facts: { outcome: "string" },
  },
  ADVANCE_PAID: {
    category: "PAY",
    level: "INFO",
    receivers: "self",
    item: false,
    defaults: { IN_APP: true, PUSH: true },
    facts: {},
  },
  PAYROLL_RUN_DONE: {
    category: "PAY",
    level: "INFO",
    receivers: ["ADMIN", "PAYROLL"],
    item: false,
    defaults: { IN_APP: true, PUSH: true },
    facts: { failed: "boolean", payslips: "number", finishedAt: "number" },
  },
  CONTRACT_DUE: {
    category: "PEOPLE",
    level: "ACTION",
    receivers: ["ADMIN", "HR"],
    item: true,
    defaults: { IN_APP: true, PUSH: true },
    facts: { daysLeft: "number" },
  },
  // The direct manager decides whether the newcomer passes; the desk signs (KEHOACH 9.18 item 2).
  PROBATION_DUE: {
    category: "PEOPLE",
    level: "ACTION",
    receivers: ["ADMIN", "HR", "MANAGER"],
    item: true,
    defaults: { IN_APP: true, PUSH: true },
    facts: { daysLeft: "number" },
  },
  // The codes failing now, comma-joined; the watch keeps them current while the spell lasts (KEHOACH 9.22.2).
  BACKUP_ALERT: {
    category: "SYSTEM",
    level: "CRITICAL",
    receivers: ["ADMIN"],
    item: true,
    defaults: { IN_APP: true, PUSH: true },
    facts: { problems: "string" },
  },
  KIOSK_ALERT: {
    category: "SYSTEM",
    level: "CRITICAL",
    receivers: ["ADMIN"],
    item: true,
    defaults: { IN_APP: true, PUSH: true },
    facts: { code: "string", errorCode: "number" },
  },
  // Off until /me carries a contract card: a notice that opens nothing about it is a dead end (KEHOACH 9.15 rule 1).
  CONTRACT_ENDING: {
    category: "PEOPLE",
    level: "INFO",
    receivers: "self",
    item: false,
    defaults: { IN_APP: false, PUSH: false },
    facts: { daysLeft: "number" },
  },
};

/** Whether this account can ever receive the kind, so Settings offers only those (KEHOACH 9.21.4). */
export function receives(kind: NoticeKind, role: Role, hasRecord: boolean): boolean {
  const rule = NOTICE_KINDS[kind].receivers;
  return rule === "self" ? hasRecord : rule.includes(role);
}

/** A switch the person may turn: an item's in-app row is locked on, since the work stays theirs. */
export function mutable(kind: NoticeKind, channel: OfferedChannel): boolean {
  return !(NOTICE_KINDS[kind].item && channel === "IN_APP");
}

/** Whether facts fit what the kind declares; a key the table does not name is refused (KEHOACH 9.21.4). */
export function factsFit(kind: NoticeKind, facts: Record<string, unknown>): boolean {
  const allowed = NOTICE_KINDS[kind].facts;
  return Object.entries(facts).every(([key, value]) => {
    const type = allowed[key];
    if (type === undefined) {
      return false;
    }
    if (type === "day") {
      return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
    }
    return typeof value === type;
  });
}
