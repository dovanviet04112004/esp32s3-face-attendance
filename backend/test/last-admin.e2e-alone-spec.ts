import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";

import { AppModule } from "../src/app.module.js";
import { configure } from "../src/bootstrap.js";
import { validateEnv } from "../src/config/env.schema.js";
import { PrismaService } from "../src/database/prisma.service.js";
import { UNUSABLE_PASSWORD } from "../src/modules/auth/password.js";
import { UsersService } from "../src/modules/users/users.service.js";

const LOCKED_ADMIN = "e2e-locked-admin@kiosk.local";

function lastAdmin(error: unknown): boolean {
  return (error as { message?: string }).message === "LAST_ADMIN";
}

// Alone: it counts every active administrator in the table, so it sets the others aside for its run.
describe("the last active administrator (e2e)", () => {
  let app: INestApplication;
  let db: PrismaService;
  let users: UsersService;
  let seedAdmin = "";
  let locked = "";
  let setAside: string[] = [];

  before(async () => {
    void validateEnv();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configure(app);
    await app.init();
    db = app.get(PrismaService);
    users = app.get(UsersService);
    await db.user.deleteMany({ where: { email: LOCKED_ADMIN } });

    seedAdmin = (await db.user.findUniqueOrThrow({ where: { email: "admin@kiosk.local" } })).id;
    locked = (
      await db.user.create({
        data: { email: LOCKED_ADMIN, passwordHash: UNUSABLE_PASSWORD, role: "ADMIN", active: false },
      })
    ).id;
    const others = await db.user.findMany({
      where: { role: "ADMIN", active: true, id: { not: seedAdmin } },
      select: { id: true },
    });
    setAside = others.map((one) => one.id);
    await db.user.updateMany({ where: { id: { in: setAside } }, data: { active: false } });
  });

  after(async () => {
    await db.user.updateMany({ where: { id: { in: setAside } }, data: { active: true } });
    await db.user.deleteMany({ where: { email: LOCKED_ADMIN } });
    await app.close();
  });

  it("counts a locked administrator out, so the only active one can be neither locked nor demoted", async () => {
    await assert.rejects(users.update(locked, seedAdmin, { active: false }), lastAdmin);
    await assert.rejects(users.update(locked, seedAdmin, { role: "HR" }), lastAdmin);
    const held = await db.user.findUniqueOrThrow({ where: { id: seedAdmin } });
    assert.deepEqual([held.role, held.active], ["ADMIN", true]);
  });

  it("lets an administrator go once another active one exists", async () => {
    await users.update(seedAdmin, locked, { active: true });
    await users.update(seedAdmin, locked, { role: "HR" });
    assert.equal((await db.user.findUniqueOrThrow({ where: { id: locked } })).role, "HR");
    await users.update(seedAdmin, locked, { active: false });
    assert.equal((await db.user.findUniqueOrThrow({ where: { id: locked } })).active, false);
  });
});
