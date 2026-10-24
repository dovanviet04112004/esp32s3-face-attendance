import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";

import { AppModule } from "../src/app.module.js";
import { configure } from "../src/bootstrap.js";
import { validateEnv } from "../src/config/env.schema.js";
import { PrismaService } from "../src/database/prisma.service.js";

const OLD_BOSS = "E2ERG01";
const NEW_BOSS = "E2ERG02";
const MOVED = "E2ERG03";
const STAYS = "E2ERG04";
const LEAVING = "E2ERG05";
const MADE_CODES = [OLD_BOSS, NEW_BOSS, MOVED, STAYS, LEAVING];
const DEPT = "E2ERG-DEPT";
const ELSEWHERE = "E2ERG-ELSE";
const OTHER_ENTITY = "E2ERG-LE";

interface Plan {
  applied: boolean;
  moving: { code: string; fromManager: string | null; toManager: string | null }[];
  losingSight: { managerCode: string; employees: string[] }[];
  gainingSight: { managerCode: string; employees: string[] }[];
  requestsReassigned: number;
}

describe("reorganisation (e2e)", () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication["getHttpServer"]>;
  let db: PrismaService;
  let token = "";
  let departmentId = "";
  let elsewhereId = "";
  let requestId = "";
  const idOf = new Map<string, number>();

  async function sweep(): Promise<void> {
    await db.request.deleteMany({ where: { employee: { code: { in: MADE_CODES } } } });
    await db.employee.deleteMany({ where: { code: { in: MADE_CODES } } });
    await db.department.deleteMany({ where: { code: { in: [DEPT, ELSEWHERE] } } });
    await db.legalEntity.deleteMany({ where: { code: OTHER_ENTITY } });
  }

  async function reorg(body: object, apply: boolean): Promise<request.Response> {
    return request(http)
      .post(`/org/reorg${apply ? "?apply=true" : ""}`)
      .set("Authorization", `Bearer ${token}`)
      .send(body);
  }

  before(async () => {
    const env = validateEnv();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configure(app);
    await app.init();
    http = app.getHttpServer();
    db = app.get(PrismaService);
    await sweep();

    const signedIn = await request(http)
      .post("/auth/login")
      .send({ email: "admin@kiosk.local", password: env.SEED_ADMIN_PASSWORD ?? "" });
    assert.equal(signedIn.status, 200, "admin could not sign in");
    token = signedIn.body.accessToken;

    const template = await db.employee.findFirstOrThrow({
      where: { active: true },
    });
    const department = await db.department.create({
      data: { code: DEPT, name: "Phòng thử", legalEntityId: template.legalEntityId as string },
    });
    departmentId = department.id;

    for (const code of MADE_CODES) {
      const made = await db.employee.create({
        data: {
          code,
          fullName: `Tái cơ cấu ${code}`,
          active: true,
          legalEntityId: template.legalEntityId,
          departmentId: [MOVED, STAYS].includes(code) ? department.id : template.departmentId,
        },
      });
      idOf.set(code, made.id);
    }
    for (const code of [MOVED, STAYS]) {
      await db.employee.update({
        where: { id: idOf.get(code) },
        data: { managerId: idOf.get(OLD_BOSS) },
      });
    }
    await db.employee.update({ where: { id: idOf.get(LEAVING) }, data: { leaveDate: new Date("2099-01-31") } });
    const other = await db.legalEntity.create({ data: { code: OTHER_ENTITY, name: "Pháp nhân khác" } });
    elsewhereId = (
      await db.department.create({ data: { code: ELSEWHERE, name: "Phòng pháp nhân khác", legalEntityId: other.id } })
    ).id;
    const filed = await db.request.create({
      data: {
        employeeId: idOf.get(MOVED) as number,
        kind: "REMOTE_WORK",
        state: "PENDING",
        fromDate: new Date("2026-12-01T00:00:00.000Z"),
        toDate: new Date("2026-12-02T00:00:00.000Z"),
        days: 2,
        reason: "e2e",
        approverId: idOf.get(OLD_BOSS) as number,
      },
    });
    requestId = filed.id;
  });

  after(async () => {
    await sweep();
    await app.close();
  });

  it("refuses a move that names nobody to move or nowhere to go", async () => {
    const nobody = await reorg({ toManagerCode: NEW_BOSS }, false);
    assert.equal(nobody.status, 400);
    assert.equal(nobody.body.message, "REORG_NEEDS_A_SELECTION");
    const nowhere = await reorg({ fromDepartmentId: departmentId }, false);
    assert.equal(nowhere.status, 400);
    assert.equal(nowhere.body.message, "REORG_NEEDS_A_DESTINATION");
  });

  it("names who loses sight, who gains it, and how many requests move", async () => {
    const res = await reorg({ fromDepartmentId: departmentId, toManagerCode: NEW_BOSS }, false);
    assert.equal(res.status, 201);
    const plan = res.body as Plan;
    assert.equal(plan.applied, false);
    assert.equal(plan.moving.length, 2);
    assert.deepEqual(plan.losingSight, [{ managerCode: OLD_BOSS, employees: [MOVED, STAYS] }]);
    assert.deepEqual(plan.gainingSight, [{ managerCode: NEW_BOSS, employees: [MOVED, STAYS] }]);
    assert.equal(plan.requestsReassigned, 1);

    const still = await db.employee.findUnique({ where: { id: idOf.get(MOVED) as number } });
    assert.equal(still?.managerId, idOf.get(OLD_BOSS), "a preview writes nothing");
  });

  it("refuses to hang a department under one of its own people", async () => {
    const res = await reorg({ fromDepartmentId: departmentId, toManagerCode: MOVED }, false);
    assert.equal(res.status, 409);
    assert.equal(res.body.message, "MANAGER_CYCLE");
  });

  it("refuses a department of another legal entity, or a manager with a last day set, and moves nobody", async () => {
    const away = await reorg({ fromDepartmentId: departmentId, toDepartmentId: elsewhereId }, true);
    assert.equal(away.status, 400, JSON.stringify(away.body));
    assert.equal(away.body.message, "DEPARTMENT_OTHER_ENTITY");
    const leaving = await reorg({ fromDepartmentId: departmentId, toManagerCode: LEAVING }, true);
    assert.equal(leaving.status, 409, JSON.stringify(leaving.body));
    assert.equal(leaving.body.message, "MANAGER_HAS_LEFT");
    const still = await db.employee.findMany({
      where: { code: { in: [MOVED, STAYS] } },
      select: { departmentId: true, managerId: true },
    });
    assert.ok(
      still.every((one) => one.departmentId === departmentId && one.managerId === idOf.get(OLD_BOSS)),
      "a refused reorganisation moved somebody",
    );
  });

  it("carries the move out, and takes the waiting request with it", async () => {
    const res = await reorg({ fromDepartmentId: departmentId, toManagerCode: NEW_BOSS }, true);
    assert.equal(res.status, 201);
    assert.equal((res.body as Plan).applied, true);

    const moved = await db.employee.findUnique({ where: { id: idOf.get(MOVED) as number } });
    assert.equal(moved?.managerId, idOf.get(NEW_BOSS));
    const waiting = await db.request.findUnique({ where: { id: requestId } });
    assert.equal(
      waiting?.approverId,
      idOf.get(NEW_BOSS),
      "a request left with the old manager is one nobody can answer",
    );
    const lines = await db.auditLog.findMany({
      where: { action: "employee.update", subjectId: { in: [MOVED, STAYS].map((code) => String(idOf.get(code))) } },
    });
    assert.deepEqual(
      lines.map((one) => one.meta),
      [MOVED, STAYS].map(() => ({
        fields: ["managerId"],
        reorg: true,
        managerId: { from: idOf.get(OLD_BOSS), to: idOf.get(NEW_BOSS) },
      })),
      "a move of approver was not written under each person with both ends",
    );
  });
});
