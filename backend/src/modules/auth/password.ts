import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const derive = promisify(scrypt) as (
  secret: string,
  salt: Buffer,
  length: number,
) => Promise<Buffer>;

const SALT_BYTES = 16;
const KEY_BYTES = 64;
const SCHEME = "scrypt";

export const UNUSABLE_PASSWORD = "none$";

export const LINK_BYTES = 32;

/** Hash a password for storage, salt included in the returned string. */
export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(plain, salt, KEY_BYTES);
  return `${SCHEME}$${salt.toString("base64")}$${key.toString("base64")}`;
}

const DECOY = { salt: randomBytes(SALT_BYTES), key: randomBytes(KEY_BYTES) };

function parse(stored: string | undefined): { salt: Buffer; key: Buffer } | null {
  const [scheme, salt, key] = (stored ?? "").split("$");
  if (scheme !== SCHEME || !salt || !key) {
    return null;
  }
  return { salt: Buffer.from(salt, "base64"), key: Buffer.from(key, "base64") };
}

/** Whether a password matches a stored hash; no hash still costs one scrypt, so time names no account. */
export async function verifyPassword(plain: string, stored: string | undefined): Promise<boolean> {
  const held = parse(stored);
  const against = held ?? DECOY;
  const actual = await derive(plain, against.salt, against.key.length);
  return held !== null && timingSafeEqual(against.key, actual);
}
