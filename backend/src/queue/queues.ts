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

export interface NotifyJob {
  deviceId: string;
  reason: string;
}

/** One payslip; the worker reads Payslip.sentAt, not the queue. */
export interface PayrollJob {
  type: "deliver";
  payslipId: string;
}
