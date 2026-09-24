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
const SILENT = "e2e-reg-mute";
const FIRST_CODE = "482913";
const SECOND_CODE = "730215";
const WRONG_CODE = "000001";

interface Answer {
  accepted: boolean;
  deviceId: string;
  pollIntervalS?: number;
  token?: string;
  expiresInDays?: number;
  claimRenew?: boolean;
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
    await db.device.deleteMany({ where: { id: { in: [DEVICE, STRANGER, SILENT] } } });
  }

  // The allowance runs per minute across the whole suite, and the last case
  // needs to know how much of it the cases above already spent.
  let asked = 0;

  async function register(body: object, claimCode = FIRST_CODE): Promise<request.Response> {
    asked += 1;
    return request(http)
      .post("/devices/register")
      .send({ claimCode, ...body });
  }

  function approve(id: string, claimCode: string): request.Test {
    return request(http)
      .post(`/devices/${id}/approve`)
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Cửa thử", location: "Tầng 1", claimCode });
  }

  // Every wait names the pace, or the kiosk falls back to backing off (KEHOACH 7.3).
  function paced(res: request.Response): void {
    assert.equal(res.status, 202);
    assert.equal(
      (res.body as Answer).pollIntervalS,
      validateEnv().DEVICE_POLL_INTERVAL_S,
      "a waiting machine was not told how often to ask",
    );
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
    paced(res);
    const answer = res.body as Answer;
    assert.equal(answer.deviceId, DEVICE);
    assert.equal(answer.token, undefined, "a machine nobody approved was given a token");
    assert.deepEqual(await held(DEVICE), { status: "PENDING", tokenHash: null });
  });

  it("keeps answering wait while it is still waiting", async () => {
    const res = await register({ deviceId: DEVICE, bootstrapToken: bootstrap });
    paced(res);
    assert.equal((res.body as Answer).token, undefined);
  });

  it("will not approve on a code that is not the one on the screen", async () => {
    const res = await approve(DEVICE, WRONG_CODE);
    assert.equal(res.status, 400);
    assert.equal(res.body.message, "DEVICE_CLAIM_MISMATCH");
    assert.equal((await held(DEVICE))?.status, "PENDING");
  });

  it("locks a code typed wrong too often and tells the kiosk to show a new one", async () => {
    const attempts = validateEnv().DEVICE_CLAIM_ATTEMPTS;
    for (let tried = 1; tried < attempts; tried += 1) {
      assert.equal((await approve(DEVICE, WRONG_CODE)).status, 400);
    }
    const locked = await approve(DEVICE, FIRST_CODE);
    assert.equal(locked.status, 409, "the right code still worked after the lock");
    assert.equal(locked.body.message, "DEVICE_CLAIM_LOCKED");

    const told = await register({ deviceId: DEVICE, bootstrapToken: bootstrap });
    paced(told);
    assert.equal((told.body as Answer).claimRenew, true, "the kiosk was not told to renew");

    const renewed = await register({ deviceId: DEVICE, bootstrapToken: bootstrap }, SECOND_CODE);
    assert.equal(renewed.status, 202);
    assert.equal((renewed.body as Answer).claimRenew, undefined);
  });

  it("will not approve a machine that never showed a code", async () => {
    await db.device.create({ data: { id: SILENT } });
    const res = await approve(SILENT, FIRST_CODE);
    assert.equal(res.status, 409);
    assert.equal(res.body.message, "DEVICE_CLAIM_MISSING");
  });

  it("hands over the token on the first ask after a person approves", async () => {
    const approved = await approve(DEVICE, SECOND_CODE);
    assert.equal(approved.status, 201, JSON.stringify(approved.body));
    assert.equal(approved.body.claimHash, undefined, "the approval answer leaked the code hash");

    const res = await register({ deviceId: DEVICE, bootstrapToken: bootstrap }, SECOND_CODE);
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
    paced(res);
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
    paced(res);
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
    const env = validateEnv();
    const allowance = env.DEVICE_REGISTER_ATTEMPTS_PER_MINUTE;
    assert.ok(
      allowance >= 2 * Math.ceil(60 / env.DEVICE_POLL_INTERVAL_S),
      "two kiosks waiting behind one address would outrun the allowance at the pace they are given",
    );
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
