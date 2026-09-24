import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";

// The config module validates at import, so publishing is switched on ahead of loading the app.
const PUBLISHER = "e2e-release-publisher-token-0123456789abcdef";
const SHELF = mkdtempSync(join(tmpdir(), "e2e-releases-"));
process.env.RELEASE_PUBLISH_TOKEN = PUBLISHER;
process.env.RELEASE_DIR = SHELF;
const { AppModule } = await import("../src/app.module.js");
const { configure } = await import("../src/bootstrap.js");
const { validateEnv } = await import("../src/config/env.schema.js");
const { PrismaService } = await import("../src/database/prisma.service.js");
const { ModelsService } = await import("../src/modules/models/models.service.js");
const { MqttService } = await import("../src/modules/mqtt/mqtt.service.js");

const VERSION = "98.0.1";
const OLDER = "98.0.0";
const BEHIND = "e2e-rel-behind";
const CURRENT = "e2e-rel-current";
const WAITING = "e2e-rel-pending";

/** Just enough of an ESP-IDF app image to be read as one: header magic and the app descriptor. */
function appImage(version: string, bytes = 4096): Buffer {
  const image = Buffer.alloc(bytes, 0x5a);
  image[0] = 0xe9;
  image.writeUInt32LE(0xabcd5432, 0x20);
  image.fill(0, 0x30, 0x50);
  image.write(version, 0x30, "utf8");
  return image;
}

describe("releases (e2e)", () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication["getHttpServer"]>;
  let db: InstanceType<typeof PrismaService>;
  let admin = "";
  let releaseId = "";
  const image = appImage(VERSION);
  const offers: { deviceId: string; url: string }[] = [];

  function publish(query: string, body: Buffer, token = PUBLISHER): request.Test {
    return request(http)
      .post(`/releases?${query}`)
      .set("Authorization", `Bearer ${token}`)
      .set("Content-Type", "application/octet-stream")
      .send(body);
  }

  function asAdmin(method: "get" | "post", path: string): request.Test {
    return request(http)[method](path).set("Authorization", `Bearer ${admin}`);
  }

  function pathOf(url: string): string {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  }

  async function sweep(): Promise<void> {
    await db.release.deleteMany({ where: { version: { startsWith: "98." } } });
    await db.device.deleteMany({ where: { id: { in: [BEHIND, CURRENT, WAITING] } } });
  }

  before(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configure(app);
    await app.init();
    http = app.getHttpServer();
    db = app.get(PrismaService);
    app.get(MqttService).publishDown = async (_name: string, deviceId: string, payload: unknown) => {
      offers.push({ deviceId, url: (payload as { url: string }).url });
    };
    await sweep();
    await db.device.createMany({
      data: [
        { id: BEHIND, status: "APPROVED", fwVersion: OLDER },
        { id: CURRENT, status: "APPROVED", fwVersion: VERSION },
        { id: WAITING, status: "PENDING", fwVersion: OLDER },
      ],
    });
    const signed = await request(http)
      .post("/auth/login")
      .send({ email: "admin@kiosk.local", password: validateEnv().SEED_ADMIN_PASSWORD ?? "" });
    assert.equal(signed.status, 200, "the seeded admin could not sign in");
    admin = signed.body.accessToken as string;
  });

  after(async () => {
    await sweep();
    rmSync(SHELF, { recursive: true, force: true });
    await app.close();
  });

  it("turns away a publisher without the token", async () => {
    const wrong = await publish(`target=FIRMWARE&version=${VERSION}`, image, "not-the-publishing-token");
    assert.equal(wrong.status, 401);
    assert.equal(wrong.body.message, "PUBLISH_TOKEN_REJECTED");
    const person = await request(http)
      .post(`/releases?target=FIRMWARE&version=${VERSION}`)
      .set("Authorization", `Bearer ${admin}`)
      .set("Content-Type", "application/octet-stream")
      .send(image);
    assert.equal(person.status, 401, "a signed-in admin could publish through the machine door");
  });

  it("refuses a file that is not an app image, and a version in the wrong shape", async () => {
    const noise = await publish(`target=FIRMWARE&version=${VERSION}`, Buffer.alloc(4096, 1));
    assert.equal(noise.status, 400);
    assert.equal(noise.body.message, "RELEASE_NOT_APP_IMAGE");
    const shape = await publish("target=FIRMWARE&version=v98", image);
    assert.equal(shape.status, 400);
    assert.equal(shape.body.message, "RELEASE_VERSION_INVALID");
    const assets = await publish("target=ASSETS&version=sha-000000000000", image);
    assert.equal(assets.status, 400, "assets were published though no kiosk can install them");
  });

  it("refuses a firmware image that states another version inside", async () => {
    const res = await publish(`target=FIRMWARE&version=${VERSION}`, appImage("98.0.7"));
    assert.equal(res.status, 400);
    assert.equal(res.body.message, "RELEASE_VERSION_MISMATCH");
    assert.equal(await db.release.count({ where: { version: VERSION } }), 0);
  });

  it("publishes a firmware image with the digest of the file it kept", async () => {
    const res = await publish(`target=FIRMWARE&version=${VERSION}`, image);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.existing, false);
    releaseId = res.body.release.releaseId as string;
    assert.equal(res.body.release.sha256, createHash("sha256").update(image).digest("hex"));
    assert.equal(res.body.release.sizeBytes, image.length);
    assert.equal(res.body.release.available, true);
    assert.equal("path" in res.body.release, false, "the dashboard was handed a server path");
    const row = await db.release.findUniqueOrThrow({ where: { releaseId } });
    assert.ok(row.path && existsSync(join(SHELF, row.path)), "the file is not where the row says");
  });

  it("answers the same version again with the release it has", async () => {
    const again = await publish(`target=FIRMWARE&version=${VERSION}`, appImage(VERSION, 8192));
    assert.equal(again.status, 201);
    assert.equal(again.body.existing, true);
    assert.equal(again.body.release.releaseId, releaseId);
    assert.equal(again.body.release.sizeBytes, image.length, "a second upload replaced the first");
  });

  it("lists the newest firmware and which approved kiosks run something older", async () => {
    const res = await asAdmin("get", "/releases/fleet");
    assert.equal(res.status, 200);
    const firmware = (res.body as { release: { releaseId: string }; behind: string[] }[]).find(
      (one) => one.release.releaseId === releaseId,
    );
    assert.ok(firmware, "the published firmware is not offered");
    assert.ok(firmware.behind.includes(BEHIND));
    assert.ok(!firmware.behind.includes(CURRENT), "a kiosk on this release was counted as behind");
    assert.ok(!firmware.behind.includes(WAITING), "a kiosk nobody approved was counted");
  });

  it("will not offer a kiosk the release it runs, nor one nobody approved", async () => {
    const running = await asAdmin("post", `/releases/${releaseId}/offer/${CURRENT}`);
    assert.equal(running.status, 409);
    assert.equal(running.body.message, "RELEASE_ALREADY_RUNNING");
    const pending = await asAdmin("post", `/releases/${releaseId}/offer/${WAITING}`);
    assert.equal(pending.status, 409);
    assert.equal(pending.body.message, "DEVICE_NOT_APPROVED");
  });

  it("hands a kiosk a link signed for it alone, which serves the exact file", async () => {
    offers.length = 0;
    const res = await asAdmin("post", `/releases/${releaseId}/offer/${BEHIND}`);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const sent = offers.find((one) => one.deviceId === BEHIND);
    assert.ok(sent, "no manifest went down to the kiosk");
    assert.ok(sent.url.startsWith("https://"), sent.url);
    const got = await request(http).get(pathOf(sent.url)).buffer(true).parse((res2, done) => {
      const parts: Buffer[] = [];
      res2.on("data", (chunk: Buffer) => parts.push(chunk));
      res2.on("end", () => done(null, Buffer.concat(parts)));
    });
    assert.equal(got.status, 200);
    assert.ok(Buffer.compare(got.body as Buffer, image) === 0, "the link served other bytes");

    const link = new URL(sent.url);
    const other = new URL(sent.url);
    other.searchParams.set("device", CURRENT);
    assert.equal((await request(http).get(pathOf(other.toString()))).status, 403, "the link opened for another kiosk");
    const bent = new URL(sent.url);
    bent.searchParams.set("sig", "0".repeat(64));
    assert.equal((await request(http).get(pathOf(bent.toString()))).status, 403, "a forged signature was taken");
    const expiresS = Math.floor(Date.now() / 1000) - 60;
    const stale = new URL(sent.url);
    const signer = app.get(ModelsService) as unknown as { signature(r: string, d: string, e: number): string };
    stale.searchParams.set("exp", String(expiresS));
    stale.searchParams.set("sig", signer.signature(releaseId, BEHIND, expiresS));
    const late = await request(http).get(pathOf(stale.toString()));
    assert.equal(late.status, 403, "an expired link still served the file");
    assert.equal(late.body.message, "RELEASE_LINK_REJECTED");

    await db.device.update({ where: { id: BEHIND }, data: { status: "REVOKED" } });
    assert.equal((await request(http).get(pathOf(link.toString()))).status, 403, "a revoked kiosk still downloaded");
    await db.device.update({ where: { id: BEHIND }, data: { status: "APPROVED" } });
  });

  it("reads the offer as waiting, then failed with the kiosk's reason, then installed", async () => {
    const waiting = await asAdmin("get", `/releases/status/${BEHIND}`);
    assert.equal(waiting.status, 200);
    assert.equal(waiting.body.state, "WAITING");
    assert.equal(waiting.body.version, VERSION);

    await db.deviceEvent.create({
      data: {
        deviceId: BEHIND,
        type: "OTA_FAILED",
        severity: "ERROR",
        message: "image does not fit the slot",
        ts: new Date(Date.now() + 1000),
      },
    });
    const failed = await asAdmin("get", `/releases/status/${BEHIND}`);
    assert.equal(failed.body.state, "FAILED");
    assert.equal(failed.body.reason, "image does not fit the slot");

    await db.device.update({ where: { id: BEHIND }, data: { fwVersion: VERSION } });
    const installed = await asAdmin("get", `/releases/status/${BEHIND}`);
    assert.equal(installed.body.state, "INSTALLED", "a kiosk on the new release still reads as failed");
  });

  it("offers everyone behind in one press, and nobody already on it or unapproved", async () => {
    await db.device.update({ where: { id: BEHIND }, data: { fwVersion: OLDER } });
    offers.length = 0;
    const res = await asAdmin("post", `/releases/${releaseId}/offer`);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const offered = res.body.offered as string[];
    assert.ok(offered.includes(BEHIND));
    assert.ok(!offered.includes(CURRENT), "a kiosk already on the release was offered it again");
    assert.ok(!offered.includes(WAITING), "an unapproved kiosk was offered a release");
    assert.deepEqual(res.body.failed, []);
  });
});
