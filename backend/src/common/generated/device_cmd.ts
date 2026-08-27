// GENERATED FILE - DO NOT EDIT.
// Source: contracts/schema/device_cmd.schema.json
// Regenerate: ./tools/gen_from_schema.sh

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
    matchThreshold?: number;
    livenessThreshold?: number;
    dedupWindowMinutes?: number;
    wakeDistanceCm?: number;
  };
}
