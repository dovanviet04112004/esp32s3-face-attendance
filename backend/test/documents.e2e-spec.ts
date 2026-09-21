import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";

import { AppModule } from "../src/app.module.js";
import { configure } from "../src/bootstrap.js";
import { validateEnv } from "../src/config/env.schema.js";
import { PrismaService } from "../src/database/prisma.service.js";
import { hashPassword } from "../src/modules/auth/password.js";

const PASSWORD = "kiosk-e2e-password";
const READER = "NV9111D";
const OUTSIDER = "NV9112D";
const READER_EMAIL = "nv9111d@kiosk.local";
const GENERAL = "E2E-NOI-QUY";
const TARGETED = "E2E-QUY-DINH-PHONG";
const CCCD = "E2E-CCCD";
const HEALTH = "E2E-KSK";
const HEALTH_MONTHS = 12;
// The seed carries one department, and a targeted document is only proved by
// somebody standing outside it.
const OTHER_DEPT = "PB9D";

interface ToRead {
  documentId: string;
  code: string;
  versionId: string;
  version: number;
  ackAt: string | null;
}

interface Gap {
  employeeId: number;
  code: string;
  missing: { code: string }[];
  expired: { code: string; expiresAt: string }[];
}

describe("documents (e2e)", () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication["getHttpServer"]>;
  let db: PrismaService;
  let adminToken = "";
  let mineToken = "";
  let readerId = 0;
  let outsiderId = 0;
  let generalId = "";
  let targetedId = "";
  let cccdTypeId = "";
  let healthTypeId = "";

  async function sweep(): Promise<void> {
    await db.user.deleteMany({ where: { email: READER_EMAIL } });
    await db.employee.deleteMany({ where: { code: { in: [READER, OUTSIDER] } } });
    await db.document.deleteMany({ where: { code: { in: [GENERAL, TARGETED] } } });
    await db.personnelFileType.deleteMany({ where: { code: { in: [CCCD, HEALTH] } } });
    await db.department.deleteMany({ where: { code: OTHER_DEPT } });
  }

  async function mine(): Promise<ToRead[]> {
    const res = await request(http)
      .get("/me/documents")
      .set("Authorization", `Bearer ${mineToken}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body as ToRead[];
  }

  async function publish(documentId: string, body: string): Promise<string> {
    const res = await request(http)
      .post(`/documents/${documentId}/versions`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ body });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body.id as string;
  }

  async function gaps(): Promise<Gap[]> {
    const res = await request(http)
      .get("/personnel-files/gaps")
      .set("Authorization", `Bearer ${adminToken}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body as Gap[];
  }

  function gapOf(rows: Gap[], employeeId: number): Gap {
    const row = rows.find((one) => one.employeeId === employeeId);
    assert.ok(row, "that person is not in the gap list");
    return row;
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

    const asAdmin = await request(http)
      .post("/auth/login")
      .send({ email: "admin@kiosk.local", password: env.SEED_ADMIN_PASSWORD ?? "" });
    assert.equal(asAdmin.status, 200, "admin could not sign in");
    adminToken = asAdmin.body.accessToken;

    const template = await db.employee.findFirstOrThrow({
      where: { active: true, departmentId: { not: null } },
    });
    const other = await db.department.create({
      data: {
        code: OTHER_DEPT,
        name: "Phòng thử tài liệu",
        legalEntityId: (await db.department.findUniqueOrThrow({
          where: { id: template.departmentId as string },
        })).legalEntityId,
      },
    });

    const person = await db.employee.create({
      data: {
        code: READER,
        fullName: "Thử tài liệu",
        departmentId: template.departmentId,
        legalEntityId: template.legalEntityId,
      },
    });
    readerId = person.id;
    const away = await db.employee.create({
      data: {
        code: OUTSIDER,
        fullName: "Thử phòng khác",
        departmentId: other.id,
        legalEntityId: template.legalEntityId,
      },
    });
    outsiderId = away.id;

    await db.user.create({
      data: {
        email: READER_EMAIL,
        passwordHash: await hashPassword(PASSWORD),
        role: "EMPLOYEE",
        employeeId: readerId,
      },
    });
    const asMine = await request(http)
      .post("/auth/login")
      .send({ email: READER_EMAIL, password: PASSWORD });
    assert.equal(asMine.status, 200, "the reader could not sign in");
    mineToken = asMine.body.accessToken;

    for (const [code, title, departmentId] of [
      [GENERAL, "Nội quy chung", null],
      [TARGETED, "Quy định phòng", template.departmentId],
    ] as const) {
      const res = await request(http)
        .post("/documents")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ code, title, ...(departmentId ? { departmentId } : {}) });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      if (code === GENERAL) {
        generalId = res.body.id;
      } else {
        targetedId = res.body.id;
      }
    }

    for (const [code, name, validMonths] of [
      [CCCD, "Căn cước công dân", null],
      [HEALTH, "Giấy khám sức khoẻ", HEALTH_MONTHS],
    ] as const) {
      const res = await request(http)
        .post("/personnel-file-types")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ code, name, ...(validMonths ? { validMonths } : {}) });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      if (code === CCCD) {
        cccdTypeId = res.body.id;
      } else {
        healthTypeId = res.body.id;
      }
    }
  });

  after(async () => {
    await sweep();
    await app.close();
  });

  it("numbers versions from one, upwards", async () => {
    await publish(generalId, "Bản một");
    await publish(targetedId, "Quy định phòng bản một");
    const second = await publish(generalId, "Bản hai");
    const row = await db.documentVersion.findUniqueOrThrow({ where: { id: second } });
    assert.equal(row.version, 2);
  });

  it("aims a targeted document at its department and nobody else", async () => {
    const seen = (await mine()).map((row) => row.code).sort();
    assert.deepEqual(seen, [GENERAL, TARGETED].sort());
    const reach = await request(http)
      .get(`/documents/${targetedId}/readers`)
      .set("Authorization", `Bearer ${adminToken}`);
    assert.equal(reach.status, 200);
    const ids = (reach.body as { employeeId: number }[]).map((one) => one.employeeId);
    assert.ok(ids.includes(readerId), "the reader is inside the target department");
    assert.ok(!ids.includes(outsiderId), "somebody else's department was reached");
  });

  it("offers only the newest wording", async () => {
    const row = (await mine()).find((one) => one.code === GENERAL);
    assert.equal(row?.version, 2, "an older version is still being offered");
  });

  it("counts a signature against the version it was given", async () => {
    const before = (await mine()).find((one) => one.code === GENERAL);
    assert.ok(before && before.ackAt === null);
    const res = await request(http)
      .post(`/me/documents/${before.versionId}/ack`)
      .set("Authorization", `Bearer ${mineToken}`);
    assert.equal(res.status, 201, JSON.stringify(res.body));

    const after = (await mine()).find((one) => one.code === GENERAL);
    assert.ok(after?.ackAt, "the signature did not come back");
    const unread = await request(http)
      .get("/me/documents/unread")
      .set("Authorization", `Bearer ${mineToken}`);
    assert.equal(unread.body.total, 1, "only the targeted document is left unread");
  });

  it("puts everybody back at unread when the next wording lands", async () => {
    await publish(generalId, "Bản ba");
    const row = (await mine()).find((one) => one.code === GENERAL);
    assert.equal(row?.version, 3);
    assert.equal(row?.ackAt, null, "a signature for version 2 was reused for version 3");
    const kept = await db.documentAck.count({ where: { employeeId: readerId } });
    assert.equal(kept, 1, "the older signature was destroyed rather than kept");
  });

  it("refuses a signature for a version aimed at somebody else", async () => {
    const away = await db.document.findFirstOrThrow({
      where: { code: TARGETED },
      include: { versions: true },
    });
    await db.employee.update({ where: { id: readerId }, data: { departmentId: null } });
    const res = await request(http)
      .post(`/me/documents/${away.versions[0].id}/ack`)
      .set("Authorization", `Bearer ${mineToken}`);
    assert.equal(res.status, 404);
    const back = await db.employee.findUniqueOrThrow({ where: { id: outsiderId } });
    await db.employee.update({
      where: { id: readerId },
      data: { departmentId: away.departmentId ?? back.departmentId },
    });
  });

  it("reports a required paper nobody handed in", async () => {
    const row = gapOf(await gaps(), readerId);
    assert.deepEqual(
      row.missing.map((one) => one.code).sort(),
      [CCCD, HEALTH].sort(),
    );
  });

  it("clears the gap once the paper arrives, and dates the expiry from the type", async () => {
    const res = await request(http)
      .post("/personnel-files")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ employeeId: readerId, typeId: cccdTypeId, receivedAt: "2026-09-21" });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.expiresAt, null, "a paper with no validity got an expiry anyway");

    const dated = await request(http)
      .post("/personnel-files")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ employeeId: readerId, typeId: healthTypeId, receivedAt: "2026-09-21" });
    assert.equal(dated.status, 201);
    assert.equal(String(dated.body.expiresAt).slice(0, 10), "2027-09-21");

    const rows = await gaps();
    assert.equal(
      rows.find((one) => one.employeeId === readerId),
      undefined,
      "somebody with every paper on file is still listed as short",
    );
  });

  it("counts an expired paper as a gap again", async () => {
    // Re-received with an old date, so the expiry is derived rather than typed:
    // the constraint refuses an expiry that precedes its own receipt.
    const res = await request(http)
      .post("/personnel-files")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ employeeId: readerId, typeId: healthTypeId, receivedAt: "2024-01-10" });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(String(res.body.expiresAt).slice(0, 10), "2025-01-10");

    const row = gapOf(await gaps(), readerId);
    assert.deepEqual(row.missing, []);
    assert.deepEqual(
      row.expired.map((one) => one.code),
      [HEALTH],
    );
  });
});
