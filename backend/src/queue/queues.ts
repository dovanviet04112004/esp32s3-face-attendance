/** Every queue name and its job shape, declared once (KEHOACH 4.9). */
export const QUEUE = {
  report: "report",
  notify: "notify",
  payroll: "payroll",
  timesheet: "timesheet",
  people: "people",
  leave: "leave",
} as const;

export type QueueName = (typeof QUEUE)[keyof typeof QUEUE];

/** Every job name; a job's `type` carries the same word, and that is what a processor reads. */
export const JOB = {
  monthly: "monthly",
  webhook: "webhook",
  contractsEnding: "contracts-ending",
  probationDue: "probation-due",
  requestsStale: "requests-stale",
  backupWatch: "backup-watch",
  noticeReconcile: "notice-reconcile",
  noticeFanout: "notice-fanout",
  noticeGather: "notice-gather",
  noticeCleanup: "notice-cleanup",
  kioskAlerts: "kiosk-alerts",
  tasksDue: "tasks-due",
  passwordSetup: "password-setup",
  passwordChanged: "password-changed",
  profileNotice: "profile-notice",
  deliver: "deliver",
  run: "run",
  build: "build",
  nightly: "nightly",
  rebuild: "rebuild",
  leavingsDue: "leavings-due",
  leavingsNow: "leavings-now",
  leaveYear: "leave-year",
} as const;

export interface ReportJob {
  type: typeof JOB.monthly;
  from: string;
  to: string;
}

export interface WebhookJob {
  type?: typeof JOB.webhook;
  deviceId: string;
  reason: string;
}

export interface ContractsEndingJob {
  type: typeof JOB.contractsEnding;
}

export interface ProbationDueJob {
  type: typeof JOB.probationDue;
}

export interface RequestsStaleJob {
  type: typeof JOB.requestsStale;
}

export interface BackupWatchJob {
  type: typeof JOB.backupWatch;
}

/** Closes and regroups items from the business tables; running it twice changes nothing more. */
export interface NoticeReconcileJob {
  type: typeof JOB.noticeReconcile;
}

/** Up to a thousand rows to push; a retry resends under the same tag, which a device shows once. */
export interface NoticeFanoutJob {
  type: typeof JOB.noticeFanout;
  kind: string;
  rows: { id: string; userId: string; tag: string; renotify: boolean }[];
}

export interface NoticeCleanupJob {
  type: typeof JOB.noticeCleanup;
}

export interface KioskAlertsJob {
  type: typeof JOB.kioskAlerts;
}

export interface TasksDueJob {
  type: typeof JOB.tasksDue;
}

export interface NoticeGatherJob {
  type: typeof JOB.noticeGather;
  userId: string;
  since: string;
}

/** What the letter around the link says: a welcome, or a recovery (KEHOACH 9.4). */
export type SetupReason = "opened" | "forgot";

/** The plain link rides here, so the notify queue keeps no finished job (queue.module.ts). */
export interface PasswordSetupJob {
  type: typeof JOB.passwordSetup;
  userId: string;
  link: string;
  reason: SetupReason;
}

export interface PasswordChangedJob {
  type: typeof JOB.passwordChanged;
  userId: string;
}

/** Only the row id rides here; the address is on the row (KEHOACH 9.17.6). */
export interface ProfileNoticeJob {
  type: typeof JOB.profileNotice;
  changeId: string;
}

export type NotifyJob =
  | WebhookJob
  | ContractsEndingJob
  | ProbationDueJob
  | RequestsStaleJob
  | BackupWatchJob
  | NoticeReconcileJob
  | NoticeFanoutJob
  | NoticeGatherJob
  | NoticeCleanupJob
  | KioskAlertsJob
  | TasksDueJob
  | PasswordSetupJob
  | PasswordChangedJob
  | ProfileNoticeJob;

export interface DeliverJob {
  type: typeof JOB.deliver;
  payslipId: string;
}

export interface RunJob {
  type: typeof JOB.run;
  runId: string;
}

/** Neither trusts the queue for exactly-once: they read the row. */
export type PayrollJob = DeliverJob | RunJob;

/** A day build is an upsert on (employee, date): arriving twice is a no-op. */
export interface BuildJob {
  type: typeof JOB.build;
  from: string;
  to: string;
}

/** Yesterday for everybody, yesterday read when the job runs (KEHOACH 9.8). */
export interface NightlyJob {
  type: typeof JOB.nightly;
}

export interface RebuildJob {
  type: typeof JOB.rebuild;
  employeeId: number;
  day: string;
}

export type TimesheetJob = BuildJob | NightlyJob | RebuildJob;

/** Closes every record whose last day is behind today; the conditional write makes a rerun a no-op. */
export interface LeavingsDueJob {
  type: typeof JOB.leavingsDue;
}

/** Closes the due records of one bulk offboarding in the clicker's name; the same conditional write guards a rerun. */
export interface LeavingsNowJob {
  type: typeof JOB.leavingsNow;
  employeeIds: number[];
  through: string;
  actorId: string;
}

export type PeopleJob = LeavingsDueJob | LeavingsNowJob;

/** Opens a year's balances; with no year it is the year today falls in. A closed year never carries twice. */
export interface LeaveYearJob {
  type: typeof JOB.leaveYear;
  year?: number;
}

export type LeaveJob = LeaveYearJob;
