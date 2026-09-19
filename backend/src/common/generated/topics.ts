// GENERATED FILE - DO NOT EDIT.
// Source: contracts/mqtt_topics.yaml
// Regenerate: ./tools/gen_contracts.py

import { z, type ZodType } from "zod";

import { attendanceRecordSchema } from "./attendance_record.js";
import { deviceCmdSchema } from "./device_cmd.js";
import { deviceEventSchema } from "./device_event.js";
import { enrollPayloadSchema } from "./enroll_payload.js";
import { heartbeatSchema } from "./heartbeat.js";
import { otaManifestSchema } from "./ota_manifest.js";

export const DEVICE_ID_MAX_LEN = 32;

export type TopicName =
  | "attendance"
  | "heartbeat"
  | "event"
  | "status"
  | "enroll_report"
  | "cmd"
  | "enroll"
  | "ota"
;

export interface TopicSpec {
  readonly name: TopicName;
  readonly direction: "up" | "down";
  readonly qos: 0 | 1 | 2;
  readonly retained: boolean;
  readonly lastWill: boolean;
  build(deviceId: string): string;
  readonly wildcard: string;
  readonly schema: ZodType;
}

export const TOPICS: { readonly [K in TopicName]: TopicSpec } = {
  "attendance": {
    name: "attendance",
    direction: "up",
    qos: 1,
    retained: false,
    lastWill: false,
    build: (deviceId: string) => `kiosk/${deviceId}/up/attendance`,
    wildcard: "kiosk/+/up/attendance",
    schema: attendanceRecordSchema,
  },
  "heartbeat": {
    name: "heartbeat",
    direction: "up",
    qos: 0,
    retained: true,
    lastWill: false,
    build: (deviceId: string) => `kiosk/${deviceId}/up/heartbeat`,
    wildcard: "kiosk/+/up/heartbeat",
    schema: heartbeatSchema,
  },
  "event": {
    name: "event",
    direction: "up",
    qos: 1,
    retained: false,
    lastWill: false,
    build: (deviceId: string) => `kiosk/${deviceId}/up/event`,
    wildcard: "kiosk/+/up/event",
    schema: deviceEventSchema,
  },
  "status": {
    name: "status",
    direction: "up",
    qos: 1,
    retained: true,
    lastWill: true,
    build: (deviceId: string) => `kiosk/${deviceId}/up/status`,
    wildcard: "kiosk/+/up/status",
    schema: z.unknown(),
  },
  "enroll_report": {
    name: "enroll_report",
    direction: "up",
    qos: 1,
    retained: false,
    lastWill: false,
    build: (deviceId: string) => `kiosk/${deviceId}/up/enroll`,
    wildcard: "kiosk/+/up/enroll",
    schema: enrollPayloadSchema,
  },
  "cmd": {
    name: "cmd",
    direction: "down",
    qos: 1,
    retained: false,
    lastWill: false,
    build: (deviceId: string) => `kiosk/${deviceId}/down/cmd`,
    wildcard: "kiosk/+/down/cmd",
    schema: deviceCmdSchema,
  },
  "enroll": {
    name: "enroll",
    direction: "down",
    qos: 1,
    retained: false,
    lastWill: false,
    build: (deviceId: string) => `kiosk/${deviceId}/down/enroll`,
    wildcard: "kiosk/+/down/enroll",
    schema: enrollPayloadSchema,
  },
  "ota": {
    name: "ota",
    direction: "down",
    qos: 1,
    retained: false,
    lastWill: false,
    build: (deviceId: string) => `kiosk/${deviceId}/down/ota`,
    wildcard: "kiosk/+/down/ota",
    schema: otaManifestSchema,
  },
};
