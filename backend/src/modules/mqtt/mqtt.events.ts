import type { TopicName } from "../../common/generated/topics.js";

/** Name every kiosk message is re-emitted under, one per up topic. */
export const KIOSK_EVENT = {
  attendance: "kiosk.attendance",
  heartbeat: "kiosk.heartbeat",
  event: "kiosk.event",
  status: "kiosk.status",
  enroll_report: "kiosk.enroll_report",
} as const satisfies Partial<Record<TopicName, string>>;

/** One validated message, with the device the topic named. `retained` is the
 *  broker replaying the last copy it keeps, not the kiosk speaking now (KEHOACH 7.5).
 */
export interface KioskMessage<T = unknown> {
  topic: TopicName;
  deviceId: string;
  payload: T;
  receivedAt: Date;
  retained?: boolean;
}
