// GENERATED FILE - DO NOT EDIT.
// Source: contracts/schema/ota_manifest.schema.json
// Regenerate: ./tools/gen_from_schema.sh

/** Server to kiosk update offer. Firmware and models roll independently: the models partition is A/B on its own, so a model update never reflashes the app. */
export interface OtaManifest {
  releaseId: string;
  target: "FIRMWARE" | "MODELS" | "ASSETS";
  version: string;
  /** HTTPS only. The kiosk validates the server certificate against the CA bundled in firmware. */
  url: string;
  /** Digest of the whole image, verified after download and before the slot is marked active. */
  sha256: string;
  /** Checked against free partition space before the download starts. */
  sizeBytes: number;
  /** Detached signature over sha256. Required in production builds, where Secure Boot v2 is on. */
  signature?: string;
  /** MODELS only: refuse the image if the running firmware is older, so a new model never meets an interpreter that cannot run its ops. */
  minFwVersion?: string;
  /** MODELS only: the ml/ run directory this image came from, copied from contracts/models.lock.json. */
  runId?: string;
  /** Install without waiting for the idle window. */
  forced?: boolean;
}
