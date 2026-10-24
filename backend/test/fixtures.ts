import assert from "node:assert/strict";

import { Logger } from "@nestjs/common";
import type { LeaveType } from "@prisma/client";
import request from "supertest";

import { validateEnv } from "../src/config/env.schema.js";
import type { PrismaService } from "../src/database/prisma.service.js";
import type { IssuedTokens, SignedIn } from "../src/modules/auth/auth.service.js";

const LEAVE_CODE = "E2E-ANNUAL";
const LEAVE_DAYS = 12;
const SEED_ENTITY_CODE = "DEFAULT";

type Server = Parameters<typeof request>[0];

/** The entity prisma/seed.ts opens every database with; whoever a suite makes without an entity of its own belongs here. */
export async function seedEntityId(db: PrismaService): Promise<string> {
  return (await db.legalEntity.findUniqueOrThrow({ where: { code: SEED_ENTITY_CODE }, select: { id: true } })).id;
}

/** The paid annual leave a suite books against, which the minimal seed lacks. */
export async function paidLeaveType(db: PrismaService): Promise<LeaveType> {
  await db.leaveType.createMany({
    data: [{ code: LEAVE_CODE, name: "Phép năm (e2e)", paid: true, daysPerYear: LEAVE_DAYS }],
    skipDuplicates: true,
  });
  return db.leaveType.findUniqueOrThrow({ where: { code: LEAVE_CODE } });
}

/** Publish as a kiosk through the broker's admin api, as the acl denies services every up topic.
 *  A null payload with `retain` clears the broker's copy. */
export async function publishAsKiosk(
  topic: string,
  payload: unknown,
  options: { qos?: 0 | 1; retain?: boolean } = {},
): Promise<void> {
  const { EMQX_API_URL: api, EMQX_API_USERNAME: username, EMQX_API_PASSWORD: password } = validateEnv();
  assert.ok(api && password, "publishing as a kiosk needs EMQX_API_URL and EMQX_API_PASSWORD");
  const auth = await fetch(`${api}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const { token } = (await auth.json()) as { token: string };
  const sent = await fetch(`${api}/publish`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      topic,
      qos: options.qos ?? 1,
      retain: options.retain ?? false,
      payload: payload === null ? "" : JSON.stringify(payload),
    }),
  });
  assert.ok(sent.ok, `broker refused the test publish: ${sent.status}`);
}

/** The tokens of a sign-in; the suites run with MFA_ROLES=none, so stopping at the code step is a broken setup. */
export function tokensOf(signed: SignedIn): IssuedTokens {
  assert.ok(signed.step === "session", "a sign-in stopped at the code step");
  return signed;
}

export function postLogin(http: Server, email: string, password: string): request.Test {
  return request(http).post("/auth/login").send({ email, password });
}

/** The access token of a sign-in the case cannot go on without. */
export async function signIn(http: Server, email: string, password: string): Promise<string> {
  const res = await postLogin(http, email, password);
  assert.equal(res.status, 200, `${email} could not sign in`);
  return res.body.accessToken as string;
}

/** The messages the app logs as errors while some work runs, for a case that checks what a log gives away. */
export async function errorsDuring(work: () => Promise<unknown>): Promise<string[]> {
  const logged: string[] = [];
  const error = Logger.prototype.error;
  Logger.prototype.error = function (this: Logger, ...args: unknown[]): void {
    logged.push(String(args[0]));
    (error as (...rest: unknown[]) => void).apply(this, args);
  };
  try {
    await work();
  } finally {
    Logger.prototype.error = error;
  }
  return logged;
}

export function cellsOf(line: string): string[] {
  return line.split('","').map((one) => one.replace(/^"|"$/g, ""));
}
