// GENERATED FILE - DO NOT EDIT.
// Source: contracts/mqtt_topics.yaml
// Regenerate: ./tools/gen_contracts.py

export const DEVICE_ID_MAX_LEN = 32;

export type TopicName =
  | "attendance"
  | "heartbeat"
  | "event"
  | "status"
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
  },
  "heartbeat": {
    name: "heartbeat",
    direction: "up",
    qos: 0,
    retained: true,
    lastWill: false,
    build: (deviceId: string) => `kiosk/${deviceId}/up/heartbeat`,
    wildcard: "kiosk/+/up/heartbeat",
  },
  "event": {
    name: "event",
    direction: "up",
    qos: 1,
    retained: false,
    lastWill: false,
    build: (deviceId: string) => `kiosk/${deviceId}/up/event`,
    wildcard: "kiosk/+/up/event",
  },
  "status": {
    name: "status",
    direction: "up",
    qos: 1,
    retained: true,
    lastWill: true,
    build: (deviceId: string) => `kiosk/${deviceId}/up/status`,
    wildcard: "kiosk/+/up/status",
  },
  "cmd": {
    name: "cmd",
    direction: "down",
    qos: 1,
    retained: false,
    lastWill: false,
    build: (deviceId: string) => `kiosk/${deviceId}/down/cmd`,
    wildcard: "kiosk/+/down/cmd",
  },
  "enroll": {
    name: "enroll",
    direction: "down",
    qos: 1,
    retained: false,
    lastWill: false,
    build: (deviceId: string) => `kiosk/${deviceId}/down/enroll`,
    wildcard: "kiosk/+/down/enroll",
  },
  "ota": {
    name: "ota",
    direction: "down",
    qos: 1,
    retained: false,
    lastWill: false,
    build: (deviceId: string) => `kiosk/${deviceId}/down/ota`,
    wildcard: "kiosk/+/down/ota",
  },
};
