/** Every queue name and its job shape, declared once (KEHOACH 4.9). */
export const QUEUE = {
  report: "report",
  notify: "notify",
  payroll: "payroll",
  timesheet: "timesheet",
} as const;

export type QueueName = (typeof QUEUE)[keyof typeof QUEUE];

export interface ReportJob {
  type: "monthly";
  from: string;
  to: string;
}

export interface WebhookJob {
  type?: "webhook";
  deviceId: string;
  reason: string;
}

export interface ContractsEndingJob {
  type: "contracts-ending";
}

export interface RequestsStaleJob {
  type: "requests-stale";
}

export interface BackupWatchJob {
  type: "backup-watch";
}

/** The link rides here: the server keeps only its hash (KEHOACH 9.4). */
/** What the letter around the link says: a welcome, or a recovery (KEHOACH 9.4). */
export type SetupReason = "opened" | "forgot";

export interface PasswordSetupJob {
  type: "password-setup";
  userId: string;
  link: string;
  reason: SetupReason;
}

/** Only the row id rides here; the address is on the row (KEHOACH 9.17.6). */
export interface ProfileNoticeJob {
  type: "profile-notice";
  changeId: string;
}

export type NotifyJob =
  | WebhookJob
  | ContractsEndingJob
  | RequestsStaleJob
  | BackupWatchJob
  | PasswordSetupJob
  | ProfileNoticeJob;

export interface DeliverJob {
  type: "deliver";
  payslipId: string;
}

export interface RunJob {
  type: "run";
  runId: string;
}

/** Neither trusts the queue for exactly-once: they read the row. */
export type PayrollJob = DeliverJob | RunJob;

/** A day build is an upsert on (employee, date): arriving twice is a no-op. */
export interface BuildJob {
  type: "build";
  from: string;
  to: string;
}

export type TimesheetJob = BuildJob;
