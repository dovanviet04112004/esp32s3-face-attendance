import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import type { INestApplication } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { Test } from "@nestjs/testing";
import mqtt from "mqtt";
import request from "supertest";

import { AppModule } from "../src/app.module.js";
import { configure } from "../src/bootstrap.js";
import { validateEnv } from "../src/config/env.schema.js";
import { PrismaService } from "../src/database/prisma.service.js";
import { AuthService, deviceFingerprint } from "../src/modules/auth/auth.service.js";

const KIOSK = "e2e-ba-door";
const OTHER = "e2e-ba-side";
const WAITING = "e2e-ba-wait";
const KICK_WAIT_MS = 5000;

describe("broker login and device tickets (e2e)", () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication["getHttpServer"]>;
  let db: PrismaService;
  let auth: AuthService;
  let admin = "";
  let ticket = "";

  async function sweep(): Promise<void> {
    await db.device.deleteMany({ where: { id: { in: [KIOSK, OTHER, WAITING] } } });
  }

  /** Put a device on the books holding one issued ticket, the state a 200 from register leaves. */
  async function issued(id: string, status: "APPROVED" | "PENDING"): Promise<string> {
    const token = auth.signDevice({ deviceId: id });
    await db.device.create({
      data: { id, status, tokenHash: deviceFingerprint(token), approvedAt: new Date() },
    });
    return token;
  }

  function renew(token: string): request.Test {
    return request(http).post("/devices/me/token").set("Authorization", `Bearer ${token}`);
  }

  async function renewed(token: string): Promise<string> {
    const res = await renew(token);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.deviceId, KIOSK);
    assert.ok((res.body.expiresInDays ?? 0) > 0);
    return res.body.token as string;
  }

  async function previous(): Promise<string | null> {
    const row = await db.device.findUnique({ where: { id: KIOSK }, select: { prevTokenHash: true } });
    return row?.prevTokenHash ?? null;
  }

  function login(username: string, password: string, clientid = username): request.Test {
    return request(http).post("/mqtt/auth").send({ username, password, clientid });
  }

  async function verdict(username: string, password: string, clientid = username): Promise<string> {
    const res = await login(username, password, clientid);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.result as string;
  }

  before(async () => {
    const env = validateEnv();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configure(app);
    await app.init();
    http = app.getHttpServer();
    db = app.get(PrismaService);
    auth = app.get(AuthService);
    await sweep();

    ticket = await issued(KIOSK, "APPROVED");
    await issued(OTHER, "APPROVED");
    admin = (await auth.signIn("admin@kiosk.local", env.SEED_ADMIN_PASSWORD ?? "", {})).accessToken;
  });

  after(async () => {
    await sweep();
    await app.close();
  });

  it("lets an approved kiosk in with the ticket it was handed", async () => {
    assert.equal(await verdict(KIOSK, ticket), "allow");
  });

  it("turns away a password that is not the ticket", async () => {
    assert.equal(await verdict(KIOSK, `${ticket}x`), "deny");
    assert.equal(await verdict(KIOSK, ""), "deny");
  });

  it("turns away a real ticket presented under another kiosk's name", async () => {
    assert.equal(await verdict(OTHER, ticket), "deny");
  });

  it("turns away a real ticket asking for another kiosk's session", async () => {
    assert.equal(await verdict(KIOSK, ticket, OTHER), "deny");
  });

  it("turns away a machine nobody has approved, ticket or not", async () => {
    const own = await issued(WAITING, "PENDING");
    assert.equal(await verdict(WAITING, own), "deny");
  });

  it("turns away a ticket that has run out", async () => {
    const stale = app.get(JwtService).sign(
      { deviceId: KIOSK, exp: Math.floor(Date.now() / 1000) - 60 },
      { secret: validateEnv().JWT_DEVICE_SECRET },
    );
    await db.device.update({ where: { id: KIOSK }, data: { tokenHash: deviceFingerprint(stale) } });
    assert.equal(await verdict(KIOSK, stale), "deny");
    await db.device.update({ where: { id: KIOSK }, data: { tokenHash: deviceFingerprint(ticket) } });
  });

  it("turns away a body missing a field, which the broker reads as a refusal", async () => {
    const res = await request(http).post("/mqtt/auth").send({ username: KIOSK, clientid: KIOSK });
    assert.equal(res.status, 400);
  });

  it("leaves no audit row, since a broker login is not a decision", async () => {
    const before = await db.auditLog.count({ where: { subjectId: "/mqtt/auth" } });
    assert.equal(await verdict(KIOSK, ticket), "allow");
    assert.equal(await db.auditLog.count({ where: { subjectId: "/mqtt/auth" } }), before);
  });

  it("tells a kiosk its ticket still stands", async () => {
    const res = await request(http).get("/devices/me").set("Authorization", `Bearer ${ticket}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body, { deviceId: KIOSK });
  });

  it("tells a kiosk nothing it can use from a forged ticket", async () => {
    const res = await request(http).get("/devices/me").set("Authorization", "Bearer not.a.ticket");
    assert.equal(res.status, 401);
  });

  it("never signs the same ticket twice, even within one second", () => {
    assert.notEqual(auth.signDevice({ deviceId: KIOSK }), auth.signDevice({ deviceId: KIOSK }));
  });

  it("keeps the old ticket good until the fresh one is first used", async () => {
    const fresh = await renewed(ticket);
    assert.notEqual(fresh, ticket);
    assert.equal(await verdict(KIOSK, ticket), "allow", "renewing locked out the ticket still held");
    assert.equal(await verdict(KIOSK, fresh), "allow");
    assert.equal(await previous(), null, "using the fresh ticket left the old one alive");
    assert.equal(await verdict(KIOSK, ticket), "deny", "the old ticket outlived the fresh one's first use");
    ticket = fresh;
  });

  it("hands a kiosk whose answer was lost another ticket, and the lost one dies", async () => {
    const lost = await renewed(ticket);
    const second = await renewed(ticket);
    assert.equal(await verdict(KIOSK, lost), "deny", "a ticket nobody received still opens the door");
    assert.equal(await verdict(KIOSK, ticket), "allow", "retrying stranded the kiosk");
    assert.equal(await verdict(KIOSK, second), "allow");
    assert.equal(await verdict(KIOSK, ticket), "deny");
    ticket = second;
  });

  it("will not renew a ticket that has run out, nor one it never issued", async () => {
    const stale = app.get(JwtService).sign(
      { deviceId: KIOSK, exp: Math.floor(Date.now() / 1000) - 60 },
      { secret: validateEnv().JWT_DEVICE_SECRET },
    );
    assert.equal((await renew(stale)).status, 401);
    const stranger = auth.signDevice({ deviceId: KIOSK });
    assert.equal((await renew(stranger)).status, 401);
    assert.equal(await verdict(KIOSK, ticket), "allow", "a refused renewal cost the kiosk its ticket");
  });

  it("closes a revoked kiosk's open session at the broker", { skip: !validateEnv().EMQX_API_URL }, async () => {
    const session = await mqtt.connectAsync(validateEnv().MQTT_URL, {
      clientId: OTHER,
      reconnectPeriod: 0,
    });
    let timer: NodeJS.Timeout | undefined;
    const closed = new Promise<boolean>((done) => {
      session.once("close", () => done(true));
      timer = setTimeout(() => done(false), KICK_WAIT_MS);
    });
    const revoked = await request(http)
      .post(`/devices/${OTHER}/revoke`)
      .set("Authorization", `Bearer ${admin}`);
    assert.equal(revoked.status, 201);
    const kicked = await closed;
    clearTimeout(timer);
    await session.endAsync(true);
    assert.ok(kicked, "the session opened before the revoke outlived it");
  });

  it("stops both doors the moment a person revokes the machine", async () => {
    const revoked = await request(http)
      .post(`/devices/${KIOSK}/revoke`)
      .set("Authorization", `Bearer ${admin}`);
    assert.equal(revoked.status, 201);

    assert.equal(await verdict(KIOSK, ticket), "deny", "the broker still took a revoked ticket");
    const res = await request(http).get("/devices/me").set("Authorization", `Bearer ${ticket}`);
    assert.equal(res.status, 401, "a revoked ticket still passed the device guard");
    assert.equal(res.body.message, "DEVICE_TOKEN_REJECTED");
    assert.equal((await renew(ticket)).status, 401, "a revoked machine renewed its ticket");
  });

  it("refuses to register a name that cannot be a broker username", async () => {
    const res = await request(http)
      .post("/devices/register")
      .send({
        deviceId: "no spaces/here",
        bootstrapToken: validateEnv().DEVICE_BOOTSTRAP_TOKEN,
        claimCode: "123456",
      });
    assert.equal(res.status, 400);
    assert.equal(res.body.message, "DEVICE_ID_MALFORMED");
  });
});
