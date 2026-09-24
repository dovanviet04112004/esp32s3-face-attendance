// GENERATED FILE - DO NOT EDIT.
// Source: contracts/schema/attendance_record.schema.json
// Regenerate: ./tools/gen_contracts.py

import { z } from "zod";

/** One attendance punch produced by a kiosk. Mirrors the 48-byte on-device record of KEHOACH 6.2.5, widened to wire types. */
export interface AttendanceRecord {
  /** Kiosk identity, same value used in the MQTT topic. */
  deviceId: string;
  /** Unsigned 64-bit counter (bootCount << 32 | seq) as a decimal string. Dedup key with deviceId; a string because it can exceed the exact-integer range of JSON consumers. */
  localId: string;
  employeeId: number;
  /** Capture time, epoch milliseconds UTC. */
  ts: number;
  direction: "IN" | "OUT";
  /** Cosine similarity against the matched template. */
  matchScore: number;
  livenessScore: number;
  modelVersion: number;
  doorOpened?: boolean;
  /** Punch was recorded while the broker was unreachable. */
  capturedOffline?: boolean;
  /** ts was taken before the first successful NTP sync; treat it as approximate. */
  clockUnsynced?: boolean;
}

export const attendanceRecordSchema = z.strictObject({
  deviceId: z.string().regex(new RegExp("^[A-Za-z0-9_-]{4,32}$")),
  localId: z.string().regex(new RegExp("^[0-9]{1,20}$")),
  employeeId: z.number().int().min(0).max(2147483647),
  ts: z.number().int().min(0),
  direction: z.enum(["IN", "OUT"]),
  matchScore: z.number().min(-1).max(1),
  livenessScore: z.number().min(0).max(1),
  modelVersion: z.number().int().min(0).max(65535),
  doorOpened: z.boolean().optional(),
  capturedOffline: z.boolean().optional(),
  clockUnsynced: z.boolean().optional(),
});
