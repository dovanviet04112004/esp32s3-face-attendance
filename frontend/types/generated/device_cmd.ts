// GENERATED FILE - DO NOT EDIT.
// Source: contracts/schema/device_cmd.schema.json
// Regenerate: ./tools/gen_contracts.py

import { z } from "zod";

/** Server to kiosk command. The kiosk answers on the event topic; cmdId lets the server correlate the two. */
export interface DeviceCommand {
  /** Server-generated. The kiosk ignores a cmdId it has already executed. */
  cmdId: string;
  /** Epoch milliseconds UTC when the server issued the command. */
  ts: number;
  /** Epoch milliseconds after which the kiosk must drop the command instead of running it. Guards against a retained or long-queued OPEN_DOOR firing hours later. */
  expiresAt?: number;
  action: "OPEN_DOOR" | "REBOOT" | "SET_CONFIG" | "SYNC_TIME" | "RELOAD_FACEDB" | "ROTATE_TOKEN" | "CLEAR_LOGS" | "SET_ACTIVE_SLOT" | "DIAGNOSTICS";
  /** User id or service name, recorded in the kiosk audit event. */
  issuedBy?: string;
  /** OPEN_DOOR only: how long the door stays released. */
  openMs?: number;
  /** SET_ACTIVE_SLOT only: which models partition to boot from next. */
  activeSlot?: 0 | 1;
  /** SET_CONFIG only: the operating settings of KEHOACH 4.9. Every field is optional; absent means leave unchanged. The model thresholds travel in the models image, never here. */
  config?: {
    /** Backlight percent; the kiosk keeps its own floor. */
    brightness?: number;
    /** Speaker percent. */
    volume?: number;
    lang?: "vi" | "en";
    /** Minutes a second stamp of one person writes no record. */
    dedupWindowMinutes?: number;
    /** Smallest face box, in frame pixels, the pipeline verifies. */
    faceMinPx?: number;
    /** Distance under which someone counts as standing at the kiosk. */
    wakeDistanceCm?: number;
  };
}

export const deviceCmdSchema = z.strictObject({
  cmdId: z.string(),
  ts: z.number().int().min(0),
  expiresAt: z.number().int().min(0).optional(),
  action: z.enum(["OPEN_DOOR", "REBOOT", "SET_CONFIG", "SYNC_TIME", "RELOAD_FACEDB", "ROTATE_TOKEN", "CLEAR_LOGS", "SET_ACTIVE_SLOT", "DIAGNOSTICS"]),
  issuedBy: z.string().max(64).optional(),
  openMs: z.number().int().min(100).max(30000).optional(),
  activeSlot: z.union([z.literal(0), z.literal(1)]).optional(),
  config: z.object({
  brightness: z.number().int().min(1).max(100).optional(),
  volume: z.number().int().min(0).max(100).optional(),
  lang: z.enum(["vi", "en"]).optional(),
  dedupWindowMinutes: z.number().int().min(1).max(720).optional(),
  faceMinPx: z.number().int().min(16).max(480).optional(),
  wakeDistanceCm: z.number().int().min(4).max(130).optional(),
}).optional(),
});
