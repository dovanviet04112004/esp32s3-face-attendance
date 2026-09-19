// GENERATED FILE - DO NOT EDIT.
// Source: contracts/schema/heartbeat.schema.json
// Regenerate: ./tools/gen_contracts.py

import { z } from "zod";

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

export const heartbeatSchema = z.strictObject({
  deviceId: z.string().regex(new RegExp("^[A-Za-z0-9_-]{4,32}$")),
  ts: z.number().int().min(0),
  uptimeSeconds: z.number().int().min(0),
  fwVersion: z.string().max(32),
  modelVersion: z.string().max(32),
  rssiDbm: z.number().int().min(-127).max(0).optional(),
  heapFreeBytes: z.number().int().min(0).optional(),
  heapMinFreeBytes: z.number().int().min(0).optional(),
  psramFreeBytes: z.number().int().min(0).optional(),
  pendingUplinkCount: z.number().int().min(0).optional(),
  activeSlot: z.union([z.literal(0), z.literal(1)]).optional(),
  bootCount: z.number().int().min(0).optional(),
  rosterVersion: z.number().int().min(0).optional(),
  embeddingVersion: z.string().max(32).optional(),
});
