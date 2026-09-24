// GENERATED FILE - DO NOT EDIT.
// Source: contracts/schema/device_event.schema.json
// Regenerate: ./tools/gen_contracts.py

import { z } from "zod";

/** Anything the kiosk wants the server to know about that is not an attendance punch: spoof attempts, hardware faults, doors opened by hand. */
export interface DeviceEvent {
  deviceId: string;
  /** Epoch milliseconds UTC. */
  ts: number;
  type: "SPOOF_DETECTED" | "UNKNOWN_FACE" | "QUALITY_REJECTED" | "DOOR_OPENED_MANUALLY" | "DOOR_FAULT" | "CAMERA_FAULT" | "TOF_FAULT" | "LCD_FAULT" | "AUDIO_FAULT" | "STORAGE_FAULT" | "FACEDB_CORRUPT" | "MODEL_LOAD_FAILED" | "OTA_FAILED" | "OTA_ROLLED_BACK" | "TIME_UNSYNCED" | "BOOTED" | "COMMAND_DONE" | "COMMAND_REJECTED" | "ROSTER_REJECTED";
  /** Present on COMMAND_DONE and COMMAND_REJECTED: the cmdId of the command this reports on. */
  cmdId?: string;
  severity: "INFO" | "WARN" | "ERROR";
  /** Short human-readable detail. Never put biometric data here. */
  message?: string;
  /** Present only when the event can be tied to a known employee. */
  employeeId?: number;
  livenessScore?: number;
  /** esp_err_t value when the event came from a failing driver. */
  errorCode?: number;
}

export const deviceEventSchema = z.strictObject({
  deviceId: z.string().regex(new RegExp("^[A-Za-z0-9_-]{4,32}$")),
  ts: z.number().int().min(0),
  type: z.enum(["SPOOF_DETECTED", "UNKNOWN_FACE", "QUALITY_REJECTED", "DOOR_OPENED_MANUALLY", "DOOR_FAULT", "CAMERA_FAULT", "TOF_FAULT", "LCD_FAULT", "AUDIO_FAULT", "STORAGE_FAULT", "FACEDB_CORRUPT", "MODEL_LOAD_FAILED", "OTA_FAILED", "OTA_ROLLED_BACK", "TIME_UNSYNCED", "BOOTED", "COMMAND_DONE", "COMMAND_REJECTED", "ROSTER_REJECTED"]),
  cmdId: z.string().max(36).optional(),
  severity: z.enum(["INFO", "WARN", "ERROR"]),
  message: z.string().max(200).optional(),
  employeeId: z.number().int().min(0).max(2147483647).optional(),
  livenessScore: z.number().min(0).max(1).optional(),
  errorCode: z.number().int().optional(),
});
