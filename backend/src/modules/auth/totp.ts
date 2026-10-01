import { createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

/** RFC 6238 as every common authenticator reads it: HMAC-SHA1, six digits, 30 s steps. */
export const TOTP_DIGITS = 6;
export const TOTP_STEP_S = 30;
const SECRET_BYTES = 20;
// One step either side covers a phone whose clock is 30 s off (KEHOACH 9.4 rule 4).
const DRIFT_STEPS = 1;

export const BACKUP_CODE_COUNT = 10;
const BACKUP_CODE_LENGTH = 10;
const BACKUP_CODE_HALF = BACKUP_CODE_LENGTH / 2;
// No 0, 1, i, l or o: a code read off paper has nothing to mistake.
const BACKUP_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const BASE32_BITS = 5;

const SIX_DIGITS = /^\d{6}$/;
const BACKUP_SHAPE = new RegExp(`^[${BACKUP_ALPHABET}]{${BACKUP_CODE_LENGTH}}$`);

export type TypedCode = { kind: "totp"; code: string } | { kind: "backup"; code: string } | null;

export function newSecret(): Buffer {
  return randomBytes(SECRET_BYTES);
}

/** RFC 4648 base32 without padding, the form an otpauth URI carries. */
export function base32(bytes: Buffer): string {
  let out = "";
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = ((value << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= BASE32_BITS) {
      bits -= BASE32_BITS;
      out += BASE32_ALPHABET[(value >>> bits) & 31];
    }
  }
  return bits > 0 ? out + BASE32_ALPHABET[(value << (BASE32_BITS - bits)) & 31] : out;
}

export function stepAt(ms: number): number {
  return Math.floor(ms / 1000 / TOTP_STEP_S);
}

/** The HOTP value of one counter (RFC 4226 section 5.3); TOTP feeds it the step. */
export function codeAt(secret: Buffer, step: number, digits = TOTP_DIGITS): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac("sha1", secret).update(counter).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const value = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(value % 10 ** digits).padStart(digits, "0");
}

/** The step a code belongs to within the allowed drift, or null when it belongs to none. */
export function stepOf(secret: Buffer, code: string, nowMs: number): number | null {
  const now = stepAt(nowMs);
  const given = Buffer.from(code);
  for (const step of [now, now - DRIFT_STEPS, now + DRIFT_STEPS]) {
    const expected = Buffer.from(codeAt(secret, step));
    if (expected.length === given.length && timingSafeEqual(expected, given)) {
      return step;
    }
  }
  return null;
}

export function otpauthUri(issuer: string, account: string, secret: Buffer): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const query = new URLSearchParams({
    secret: base32(secret),
    issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_S),
  });
  return `otpauth://totp/${label}?${query.toString()}`;
}

/** Ten codes shaped `xxxxx-xxxxx`, each drawn without modulo bias. */
export function newBackupCodes(): string[] {
  return Array.from({ length: BACKUP_CODE_COUNT }, () => {
    const chars = Array.from({ length: BACKUP_CODE_LENGTH }, () => BACKUP_ALPHABET[randomInt(BACKUP_ALPHABET.length)]);
    return `${chars.slice(0, BACKUP_CODE_HALF).join("")}-${chars.slice(BACKUP_CODE_HALF).join("")}`;
  });
}

export function readCode(typed: string): TypedCode {
  const bare = typed.replace(/[\s-]/g, "").toLowerCase();
  if (SIX_DIGITS.test(bare)) {
    return { kind: "totp", code: bare };
  }
  return BACKUP_SHAPE.test(bare) ? { kind: "backup", code: bare } : null;
}
