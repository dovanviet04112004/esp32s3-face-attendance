/** Every queue name and its job shape, declared once (KEHOACH 4.9). */
export const QUEUE = {
  report: "report",
  notify: "notify",
  payroll: "payroll",
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

export type NotifyJob = WebhookJob | ContractsEndingJob;

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
