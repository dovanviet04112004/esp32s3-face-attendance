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
  /** SET_CONFIG only. Every field is optional; absent means leave unchanged. */
  config?: {
    brightness?: number;
    volume?: number;
    lang?: "vi" | "en";
    detectThreshold?: number;
    matchThreshold?: number;
    livenessThreshold?: number;
    dedupWindowMinutes?: number;
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
  brightness: z.number().int().min(0).max(255).optional(),
  volume: z.number().int().min(0).max(255).optional(),
  lang: z.enum(["vi", "en"]).optional(),
  detectThreshold: z.number().min(0).max(1).optional(),
  matchThreshold: z.number().min(0).max(1).optional(),
  livenessThreshold: z.number().min(0).max(1).optional(),
  dedupWindowMinutes: z.number().int().min(0).max(1440).optional(),
  wakeDistanceCm: z.number().int().min(10).max(200).optional(),
}).optional(),
});
