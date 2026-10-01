import type { NoticeKind, NoticeLevel, NoticeQueue, Role } from "@prisma/client";

/** The group a kind shows under in the bell and in Settings; read off this table, never stored (KEHOACH 9.21.4). */
export type NoticeCategory = "REQUESTS" | "PAY" | "PEOPLE" | "ATTENDANCE" | "SYSTEM";

export type FactType = "number" | "boolean" | "string" | "day" | "month";

export type OfferedChannel = "IN_APP" | "PUSH";

/** Kinds that are work a group shares; every other kind is news for one person (KEHOACH 9.21.4). */
export type ItemKind =
  | "REQUEST_WAITING"
  | "CONTRACT_DUE"
  | "PROBATION_DUE"
  | "BACKUP_ALERT"
  | "KIOSK_ALERT"
  | "TASK_ASSIGNED"
  | "DOCUMENT_TO_SIGN"
  | "ATTENDANCE_EXCEPTION"
  | "TEAM_ATTENDANCE";

export type NewsKind = Exclude<NoticeKind, ItemKind>;

export function kebab(name: string): string {
  return name.toLowerCase().replaceAll("_", "-");
}

/** The whole days of waiting at which a queue's work speaks again (KEHOACH 9.17 item 12, 9.21.4). */
export const QUEUE_MARKS: Partial<Record<NoticeQueue, readonly number[]>> = {
  REQUESTS: [3, 7, 14],
  ADVANCES_TO_DECIDE: [3, 7],
  ADVANCES_TO_PAY: [3, 7],
  CERTIFICATES: [3, 7],
  PROFILE_CHANGES: [3, 7],
  DEPENDENTS: [3, 7],
  DOCUMENTS: [3, 7],
};

export const DUE_SOON_DAYS = 1;

/** Days left at which work against a date speaks, opening it at the first mark if nothing has (KEHOACH 9.18, 9.21.4). */
export const DUE_MARKS: Partial<Record<NoticeQueue, readonly number[]>> = {
  CONTRACTS_DUE: [30, 15, 7],
  PROBATION_DUE: [7, 3, 1],
  TASKS: [0, -1],
};

export const DUE_WARNING: Partial<Record<NoticeQueue, number>> = {
  CONTRACTS_DUE: 7,
  TASKS: -1,
};

/** Minutes past a shift's end, with no overtime approved, that make a day an exception (KEHOACH 9.17 item 2). */
export const ATTENDANCE_OVERTIME_MINUTES = 30;

/** The exception facts that push: a missing punch and an absence change pay, the rest stays in the bell (KEHOACH 9.21.4). */
export const ATTENDANCE_PUSHED: readonly string[] = ["missing", "absent"];

export const ATTENDANCE_PUSH_CRON = "30 8 * * *";

/** Who reads a morning summary: a manager of their tree, the HR desk of the company (KEHOACH 9.21.4). */
export const TEAM_READERS: readonly Role[] = ["ADMIN", "HR", "MANAGER"];

export const TEAM_SUMMARY_AFTER_FIRST_SHIFT_MINUTES = 30;

export const TEAM_SUMMARY_CRON = "*/15 5-11 * * *";

export const KIOSK_BURST_QUIET_MINUTES = 60;

/** Kinds whose pushes gather per person in every role, as a desk's always do: one bulk change writes many rows (KEHOACH 9.21.4). */
export const GATHERED_KINDS: ReadonlySet<NoticeKind> = new Set<NoticeKind>(["SHIFT_CHANGED"]);

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
  /** Told to open screens and phones but never written: the record it speaks of is the row. */
  rowless?: true;
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
  // Whoever owns the task: the person it is about, their manager, or the desk (KEHOACH 9.21.4).
  TASK_ASSIGNED: {
    category: "PEOPLE",
    level: "ACTION",
    receivers: ["ADMIN", "HR", "PAYROLL", "MANAGER", "EMPLOYEE"],
    item: true,
    defaults: { IN_APP: true, PUSH: true },
    facts: { owner: "string", daysLeft: "number" },
  },
  DOCUMENT_TO_SIGN: {
    category: "PEOPLE",
    level: "ACTION",
    receivers: "self",
    item: true,
    defaults: { IN_APP: true, PUSH: true },
    facts: { daysWaited: "number" },
  },
  ATTENDANCE_EXCEPTION: {
    category: "ATTENDANCE",
    level: "ACTION",
    receivers: "self",
    item: true,
    defaults: { IN_APP: true, PUSH: true },
    facts: {
      day: "day",
      lateMinutes: "number",
      earlyMinutes: "number",
      overtimeMinutes: "number",
      missing: "string",
      absent: "boolean",
    },
  },
  // Said once a morning and gone with the day; the counts are the ones the reader's home page draws (KEHOACH 9.21.4).
  TEAM_ATTENDANCE: {
    category: "ATTENDANCE",
    level: "INFO",
    receivers: TEAM_READERS,
    item: true,
    defaults: { IN_APP: true, PUSH: true },
    facts: { day: "day", late: "number", notPunched: "number", absent: "number", onLeave: "number" },
  },
  // Only somebody else's hand on the day; an approved request of their own is told as its decision (KEHOACH 9.21.4).
  DAY_CORRECTED: {
    category: "ATTENDANCE",
    level: "INFO",
    receivers: "self",
    item: false,
    defaults: { IN_APP: true, PUSH: true },
    facts: { day: "day", correctedAt: "number" },
  },
  SHIFT_CHANGED: {
    category: "ATTENDANCE",
    level: "INFO",
    receivers: "self",
    item: false,
    defaults: { IN_APP: true, PUSH: true },
    facts: { day: "day" },
  },
  TIMESHEET_MONTH_CLOSED: {
    category: "ATTENDANCE",
    level: "INFO",
    receivers: "self",
    item: false,
    defaults: { IN_APP: true, PUSH: false },
    facts: { month: "month" },
  },
  // The timesheet already keeps every punch; a row here would copy it twice a day for everyone (KEHOACH 9.21.4).
  PUNCH_RECORDED: {
    category: "ATTENDANCE",
    level: "INFO",
    receivers: "self",
    item: false,
    defaults: { IN_APP: true, PUSH: false },
    facts: {},
    rowless: true,
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
    if (type === "month") {
      return typeof value === "string" && /^\d{4}-\d{2}$/.test(value);
    }
    return typeof value === type;
  });
}
