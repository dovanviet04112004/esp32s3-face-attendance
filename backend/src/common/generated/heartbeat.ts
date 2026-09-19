// GENERATED FILE - DO NOT EDIT.
// Source: contracts/schema/heartbeat.schema.json
// Regenerate: ./tools/gen_contracts.py

/** Periodic liveness and health sample from a kiosk. Published retained at QoS 0, so the last one always describes the current state. */
export interface Heartbeat {
  deviceId: string;
  /** Epoch milliseconds UTC. */
  ts: number;
  uptimeSeconds: number;
  fwVersion: string;
  /** Version string of the active models partition, from nvs:model/version. */
  modelVersion: string;
  rssiDbm?: number;
  heapFreeBytes?: number;
  /** Low-water mark since boot; a falling value across heartbeats means a leak. */
  heapMinFreeBytes?: number;
  psramFreeBytes?: number;
  /** Attendance records written to flash but not yet acknowledged by the broker. */
  pendingUplinkCount?: number;
  /** Which models partition is in use, models_0 or models_1. */
  activeSlot?: 0 | 1;
  bootCount?: number;
  /** Roster generation this device has applied. A number behind the server's own is how a kiosk that missed a deletion while offline gets told about it. */
  rosterVersion?: number;
  /** Recognition model this device compares with. A template pushed under any other value is refused, so this is the string a server has to match. */
  embeddingVersion?: string;
}
