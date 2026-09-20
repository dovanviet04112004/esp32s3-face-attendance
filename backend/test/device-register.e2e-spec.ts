import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";

import { AppModule } from "../src/app.module.js";
import { configure } from "../src/bootstrap.js";
import { validateEnv } from "../src/config/env.schema.js";
import { PrismaService } from "../src/database/prisma.service.js";

const DEVICE = "e2e-reg-door";
const STRANGER = "e2e-reg-thief";

interface Answer {
  accepted: boolean;
  deviceId: string;
  token?: string;
  expiresInDays?: number;
}

function claimsOf(token: string): { deviceId?: string; exp?: number } {
  const body = token.split(".")[1] ?? "";
  return JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
}

describe("device registration (e2e)", () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication["getHttpServer"]>;
  let db: PrismaService;
  let token = "";
  let bootstrap = "";

  async function sweep(): Promise<void> {
    await db.device.deleteMany({ where: { id: { in: [DEVICE, STRANGER] } } });
  }

  // The allowance runs per minute across the whole suite, and the last case
  // needs to know how much of it the cases above already spent.
  let asked = 0;

  async function register(body: object): Promise<request.Response> {
    asked += 1;
    return request(http).post("/devices/register").send(body);
  }

  async function held(id: string): Promise<{ status: string; tokenHash: string | null } | null> {
    return db.device.findUnique({ where: { id }, select: { status: true, tokenHash: true } });
  }

  before(async () => {
    const env = validateEnv();
    bootstrap = env.DEVICE_BOOTSTRAP_TOKEN;
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
  });

  after(async () => {
    await sweep();
    await app.close();
  });

  it("turns away a machine whose firmware carries the wrong secret", async () => {
    const res = await register({ deviceId: STRANGER, bootstrapToken: `${bootstrap}-wrong` });
    assert.equal(res.status, 401);
    assert.equal(res.body.message, "DEVICE_BOOTSTRAP_REJECTED");
    assert.equal(await held(STRANGER), null, "a refused machine still got a row");
  });

  it("puts an unknown machine in the queue without handing it anything", async () => {
    const res = await register({ deviceId: DEVICE, bootstrapToken: bootstrap, fwVersion: "0.9.1" });
    assert.equal(res.status, 202);
    const answer = res.body as Answer;
    assert.equal(answer.deviceId, DEVICE);
    assert.equal(answer.token, undefined, "a machine nobody approved was given a token");
    assert.deepEqual(await held(DEVICE), { status: "PENDING", tokenHash: null });
  });

  it("keeps answering wait while it is still waiting", async () => {
    const res = await register({ deviceId: DEVICE, bootstrapToken: bootstrap });
    assert.equal(res.status, 202);
    assert.equal((res.body as Answer).token, undefined);
  });

  it("hands over the token on the first ask after a person approves", async () => {
    const approved = await request(http)
      .post(`/devices/${DEVICE}/approve`)
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Cửa thử", location: "Tầng 1" });
    assert.equal(approved.status, 201);

    const res = await register({ deviceId: DEVICE, bootstrapToken: bootstrap });
    assert.equal(res.status, 200);
    const answer = res.body as Answer;
    assert.ok(answer.token, "an approved machine was not given its token");
    assert.equal(claimsOf(answer.token).deviceId, DEVICE, "the token names another machine");
    assert.ok((answer.expiresInDays ?? 0) > 0);

    const row = await held(DEVICE);
    assert.equal(row?.status, "APPROVED");
    assert.ok(row?.tokenHash, "nothing recorded which token this machine holds");
  });

  it("sends a machine that asks again while holding a token back for approval", async () => {
    const res = await register({ deviceId: DEVICE, bootstrapToken: bootstrap });
    assert.equal(res.status, 202, "a second ask handed out another token");
    assert.equal((res.body as Answer).token, undefined);
    assert.deepEqual(
      await held(DEVICE),
      { status: "PENDING", tokenHash: null },
      "the machine kept its standing although its storage is gone",
    );
  });

  it("takes a revoked machine back into the queue, not straight back in", async () => {
    await db.device.update({ where: { id: DEVICE }, data: { status: "REVOKED" } });
    const res = await register({ deviceId: DEVICE, bootstrapToken: bootstrap });
    assert.equal(res.status, 202);
    assert.equal((res.body as Answer).token, undefined);
    assert.deepEqual(await held(DEVICE), { status: "PENDING", tokenHash: null });
  });

  it("writes down every step under the machine it happened to", async () => {
    const res = await request(http)
      .get(`/audit?subjectType=device&subjectId=${DEVICE}`)
      .set("Authorization", `Bearer ${token}`);
    assert.equal(res.status, 200);
    const kinds = (res.body.rows as { action: string }[]).map((row) => row.action);
    assert.ok(kinds.includes("device.register"), "the first ask left no trace");
    assert.ok(kinds.includes("device.tokenIssue"), "handing out a credential left no trace");
    assert.ok(kinds.includes("device.reset"), "losing a machine's standing left no trace");
  });

  // Declared last: it spends the register allowance for the minute.
  it("lets a fleet ask its own number of times, not the number meant for people", async () => {
    const allowance = validateEnv().DEVICE_REGISTER_ATTEMPTS_PER_MINUTE;
    const spent = asked;
    let refused = false;
    for (let ask = 0; ask <= allowance + 1 && !refused; ask += 1) {
      refused = (await register({ deviceId: DEVICE, bootstrapToken: bootstrap })).status === 429;
    }
    assert.ok(refused, "a machine could ask without limit");
    assert.equal(
      asked - 1,
      allowance,
      `the register door answered ${asked - 1} times, not its own allowance of ${allowance}` +
        ` (${spent} were spent before this case)`,
    );
  });
});
