import type { TopicName } from "../../common/generated/topics.js";

/** Name every kiosk message is re-emitted under, one per up topic. */
export const KIOSK_EVENT = {
  attendance: "kiosk.attendance",
  heartbeat: "kiosk.heartbeat",
  event: "kiosk.event",
  status: "kiosk.status",
  enroll_report: "kiosk.enroll_report",
} as const satisfies Partial<Record<TopicName, string>>;

/** One validated message, with the device the topic named. */
export interface KioskMessage<T = unknown> {
  topic: TopicName;
  deviceId: string;
  payload: T;
  receivedAt: Date;
}
