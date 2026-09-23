import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { LeaveType } from "@prisma/client";

import type { PrismaService } from "../src/database/prisma.service.js";

const LEAVE_CODE = "E2E-ANNUAL";
const LEAVE_DAYS = 12;
const DASHBOARD = "http://127.0.0.1:18083/api/v5";
// A fresh broker, which is what CI starts, still answers to its factory login.
const FACTORY_PASSWORD = "public";

/** The paid annual leave a suite books against, which the minimal seed lacks. */
export async function paidLeaveType(db: PrismaService): Promise<LeaveType> {
  await db.leaveType.createMany({
    data: [{ code: LEAVE_CODE, name: "Phép năm (e2e)", paid: true, daysPerYear: LEAVE_DAYS }],
    skipDuplicates: true,
  });
  return db.leaveType.findUniqueOrThrow({ where: { code: LEAVE_CODE } });
}

function dashboardPassword(): string {
  const file = resolve(process.cwd(), "../deploy/.env");
  if (!existsSync(file)) {
    return FACTORY_PASSWORD;
  }
  return /^EMQX_DASHBOARD_PASSWORD=(.*)$/m.exec(readFileSync(file, "utf8"))?.[1]?.trim() ?? FACTORY_PASSWORD;
}

/** Publish as a kiosk through the broker's admin api: the acl denies services every up topic. */
export async function publishAsKiosk(topic: string, payload: unknown): Promise<void> {
  const auth = await fetch(`${DASHBOARD}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: dashboardPassword() }),
  });
  const { token } = (await auth.json()) as { token: string };
  const sent = await fetch(`${DASHBOARD}/publish`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ topic, qos: 1, payload: JSON.stringify(payload) }),
  });
  assert.ok(sent.ok, `broker refused the test publish: ${sent.status}`);
}
