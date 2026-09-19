import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Seal a face template for storage: iv, tag and body in one array. */
export function sealTemplate(plain: Buffer, keyBase64: string): Uint8Array<ArrayBuffer> {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, keyOf(keyBase64), iv);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Uint8Array.from(Buffer.concat([iv, cipher.getAuthTag(), body]));
}

/** Open a sealed template; a tampered row throws rather than returning noise. */
export function openTemplate(sealed: Uint8Array, keyBase64: string): Buffer {
  const held = Buffer.from(sealed);
  const decipher = createDecipheriv(ALGORITHM, keyOf(keyBase64), held.subarray(0, IV_BYTES));
  decipher.setAuthTag(held.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
  const body = held.subarray(IV_BYTES + TAG_BYTES);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

function keyOf(keyBase64: string): Buffer {
  const key = Buffer.from(keyBase64, "base64");
  if (key.length !== 32) {
    throw new Error("TEMPLATE_ENCRYPTION_KEY must decode to 32 bytes");
  }
  return key;
}
