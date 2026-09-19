// GENERATED FILE - DO NOT EDIT.
// Source: contracts/schema/device_event.schema.json
// Regenerate: ./tools/gen_contracts.py

/** Anything the kiosk wants the server to know about that is not an attendance punch: spoof attempts, hardware faults, doors opened by hand. */
export interface DeviceEvent {
  deviceId: string;
  /** Epoch milliseconds UTC. */
  ts: number;
  type: "SPOOF_DETECTED" | "UNKNOWN_FACE" | "QUALITY_REJECTED" | "DOOR_OPENED_MANUALLY" | "DOOR_FAULT" | "CAMERA_FAULT" | "TOF_FAULT" | "LCD_FAULT" | "AUDIO_FAULT" | "STORAGE_FAULT" | "FACEDB_CORRUPT" | "MODEL_LOAD_FAILED" | "OTA_FAILED" | "OTA_ROLLED_BACK" | "TIME_UNSYNCED" | "BOOTED";
  severity: "INFO" | "WARN" | "ERROR";
  /** Short human-readable detail. Never put biometric data here. */
  message?: string;
  /** Present only when the event can be tied to a known employee. */
  employeeId?: number;
  livenessScore?: number;
  /** esp_err_t value when the event came from a failing driver. */
  errorCode?: number;
}
