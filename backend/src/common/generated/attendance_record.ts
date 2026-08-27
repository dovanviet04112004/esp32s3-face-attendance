// GENERATED FILE - DO NOT EDIT.
// Source: contracts/schema/attendance_record.schema.json
// Regenerate: ./tools/gen_from_schema.sh

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
