import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";
import { promisify } from "node:util";

const derive = promisify(scrypt) as (
  secret: string,
  salt: Buffer,
  length: number,
  options: ScryptOptions,
) => Promise<Buffer>;

const SALT_BYTES = 16;
const KEY_BYTES = 64;
const SCHEME = "scrypt";
const MAX_MEM_BYTES = 64 * 1024 ** 2;

interface Cost {
  N: number;
  r: number;
  p: number;
}

// 16 MiB per hash, rated by OWASP level with N=2^17, p=1 (KEHOACH 7.2).
const COST: Cost = { N: 2 ** 14, r: 8, p: 5 };
// Node's scrypt defaults, for hashes that name no cost of their own.
const UNSTATED: Cost = { N: 2 ** 14, r: 8, p: 1 };

export const UNUSABLE_PASSWORD = "none$";

export const LINK_BYTES = 32;

function costText(cost: Cost): string {
  return `N=${cost.N},r=${cost.r},p=${cost.p}`;
}

/** Hash a password for storage; the salt and the scrypt cost travel in the returned string. */
export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(plain, salt, KEY_BYTES, { ...COST, maxmem: MAX_MEM_BYTES });
  return `${SCHEME}$${costText(COST)}$${salt.toString("base64")}$${key.toString("base64")}`;
}

const DECOY = { cost: COST, salt: randomBytes(SALT_BYTES), key: randomBytes(KEY_BYTES) };

function costOf(text: string): Cost | null {
  const found = /^N=(\d+),r=(\d+),p=(\d+)$/.exec(text);
  return found ? { N: Number(found[1]), r: Number(found[2]), p: Number(found[3]) } : null;
}

function parse(stored: string | undefined): { cost: Cost; salt: Buffer; key: Buffer } | null {
  const parts = (stored ?? "").split("$");
  if (parts[0] !== SCHEME) {
    return null;
  }
  const [cost, salt, key] =
    parts.length === 3 ? [UNSTATED, parts[1], parts[2]] : [costOf(parts[1]), parts[2], parts[3]];
  if (!cost || !salt || !key) {
    return null;
  }
  return { cost, salt: Buffer.from(salt, "base64"), key: Buffer.from(key, "base64") };
}

/** Whether a password matches a stored hash; no hash still costs one scrypt, so time names no account. */
export async function verifyPassword(plain: string, stored: string | undefined): Promise<boolean> {
  const held = parse(stored);
  const against = held ?? DECOY;
  const actual = await derive(plain, against.salt, against.key.length, { ...against.cost, maxmem: MAX_MEM_BYTES });
  return held !== null && timingSafeEqual(against.key, actual);
}

/** Whether a matching hash carries a cost other than today's and should be made again. */
export function needsRehash(stored: string): boolean {
  const held = parse(stored);
  return held !== null && costText(held.cost) !== costText(COST);
}
