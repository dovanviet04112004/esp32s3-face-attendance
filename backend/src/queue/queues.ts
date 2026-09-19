/** Every queue name and its job shape, declared once (KEHOACH 4.9). */
export const QUEUE = {
  report: "report",
  notify: "notify",
} as const;

export type QueueName = (typeof QUEUE)[keyof typeof QUEUE];

/** Roll up attendance for a range; BullMQ may deliver it twice, so it writes
 *  nothing a second run would change.
 */
export interface ReportJob {
  type: "monthly";
  from: string;
  to: string;
}

export interface NotifyJob {
  deviceId: string;
  reason: string;
}
