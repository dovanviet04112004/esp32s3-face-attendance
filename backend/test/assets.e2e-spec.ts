import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";

import { AppModule } from "../src/app.module.js";
import { configure } from "../src/bootstrap.js";
import { validateEnv } from "../src/config/env.schema.js";
import { PrismaService } from "../src/database/prisma.service.js";

const ASSET = "E2EAS-01";
const FIRST = "E2EAS01";
const SECOND = "E2EAS02";
const MADE_CODES = [FIRST, SECOND];

interface AssetRow {
  id: string;
  code: string;
  state: string;
  holder: { code: string } | null;
}

interface Move {
  issued: boolean;
  condition: string;
  employee: { code: string };
}

describe("assets (e2e)", () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication["getHttpServer"]>;
  let db: PrismaService;
  let token = "";
  let assetId = "";
  const idOf = new Map<string, number>();

  async function sweep(): Promise<void> {
    await db.asset.deleteMany({ where: { code: ASSET } });
    await db.employee.deleteMany({ where: { code: { in: MADE_CODES } } });
  }

  async function handOver(body: object): Promise<request.Response> {
    return request(http)
      .post(`/assets/${assetId}/hand-over`)
      .set("Authorization", `Bearer ${token}`)
      .send(body);
  }

  async function read(): Promise<AssetRow> {
    const res = await request(http)
      .get(`/assets?kind=LAPTOP`)
      .set("Authorization", `Bearer ${token}`);
    assert.equal(res.status, 200);
    const row = (res.body as AssetRow[]).find((one) => one.code === ASSET);
    assert.ok(row, "the asset this suite made is missing from the list");
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

    const signedIn = await request(http)
      .post("/auth/login")
      .send({ email: "admin@kiosk.local", password: env.SEED_ADMIN_PASSWORD ?? "" });
    assert.equal(signedIn.status, 200, "admin could not sign in");
    token = signedIn.body.accessToken;

    for (const code of MADE_CODES) {
      const made = await db.employee.create({
        data: { code, fullName: `Giữ tài sản ${code}`, active: true },
      });
      idOf.set(code, made.id);
    }
    const created = await request(http)
      .post("/assets")
      .set("Authorization", `Bearer ${token}`)
      .send({ code: ASSET, name: "Máy tính thử", kind: "LAPTOP", serialNo: "SN-E2E" });
    assert.equal(created.status, 201);
    assetId = created.body.id;
  });

  after(async () => {
    await sweep();
    await app.close();
  });

  it("hands it out and shows who has it", async () => {
    const res = await handOver({ employeeId: idOf.get(FIRST), issued: true, condition: "NEW" });
    assert.equal(res.status, 201);
    const row = await read();
    assert.equal(row.state, "ISSUED");
    assert.equal(row.holder?.code, FIRST);
  });

  it("refuses to hand out what somebody is already holding", async () => {
    const res = await handOver({ employeeId: idOf.get(SECOND), issued: true });
    assert.equal(res.status, 409);
    assert.equal(res.body.message, "ASSET_ALREADY_ISSUED");
  });

  it("refuses a return from somebody who is not holding it", async () => {
    const res = await handOver({ employeeId: idOf.get(SECOND), issued: false });
    assert.equal(res.status, 409);
    assert.equal(res.body.message, "ASSET_HELD_BY_SOMEBODY_ELSE");
  });

  it("lists what a person is still holding", async () => {
    const res = await request(http)
      .get(`/employees/${idOf.get(FIRST) as number}/assets`)
      .set("Authorization", `Bearer ${token}`);
    assert.equal(res.status, 200);
    assert.equal((res.body as AssetRow[]).length, 1);
  });

  it("keeps every hand-over, so the second holder does not erase the first", async () => {
    assert.equal(
      (await handOver({ employeeId: idOf.get(FIRST), issued: false, condition: "WORN" })).status,
      201,
    );
    assert.equal(
      (await handOver({ employeeId: idOf.get(SECOND), issued: true, condition: "WORN" })).status,
      201,
    );

    const res = await request(http)
      .get(`/assets/${assetId}/history`)
      .set("Authorization", `Bearer ${token}`);
    assert.equal(res.status, 200);
    const moves = res.body as Move[];
    assert.equal(moves.length, 3, "out, back, out again");
    assert.deepEqual(
      moves.map((one) => [one.employee.code, one.issued]),
      [
        [SECOND, true],
        [FIRST, false],
        [FIRST, true],
      ],
      "newest first, and the first holder is still in the record",
    );
    assert.equal((await read()).holder?.code, SECOND);
  });

  it("leaves nothing behind when a hand-over is refused", async () => {
    const before = (await request(http)
      .get(`/assets/${assetId}/history`)
      .set("Authorization", `Bearer ${token}`)).body as Move[];
    assert.equal((await handOver({ employeeId: idOf.get(FIRST), issued: true })).status, 409);
    const after = (await request(http)
      .get(`/assets/${assetId}/history`)
      .set("Authorization", `Bearer ${token}`)).body as Move[];
    assert.equal(after.length, before.length);
  });
});
