import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
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
const { DevicesService } = await import("../src/modules/devices/devices.service.js");
const { RealtimeListener } = await import("../src/modules/realtime/realtime.listener.js");
const { ModelsService } = await import("../src/modules/models/models.service.js");
const { MqttService } = await import("../src/modules/mqtt/mqtt.service.js");
const { otaManifestSchema } = await import("../src/common/generated/ota_manifest.js");

const VERSION = "98.0.1";
const OLDER = "98.0.0";
const BEHIND = "e2e-rel-behind";
const CURRENT = "e2e-rel-current";
const WAITING = "e2e-rel-pending";
const MODELS_DOOR = "e2e-rel-models";
const CHAIN = [
  "e2e-rel-chain-a",
  "e2e-rel-chain-b",
  "e2e-rel-chain-c",
  "e2e-rel-chain-d",
  "e2e-rel-chain-e",
  "e2e-rel-chain-f",
  "e2e-rel-chain-g",
] as const;
const MODELS_PREFIX = "img-e2e0";
const KIOSK_MODELS = `${MODELS_PREFIX}0001`;
const OLD_RECOG = createHash("sha256").update("e2e recognition model, the one kiosks run").digest();
const NEW_RECOG = createHash("sha256").update("e2e recognition model, the next one").digest();

function recogName(sha: Buffer): string {
  return `recog-${sha.subarray(0, 8).toString("hex")}`;
}

/** A models image as storage_format.h lays it out: MDLS header, three entries, the recognition one named recog. */
function modelsImage(recogSha: Buffer): Buffer {
  const image = Buffer.alloc(1024, 0x11);
  image.fill(0, 0, 256);
  image.writeUInt32LE(0x534c444d, 0);
  image.writeUInt32LE(1, 4);
  image.writeUInt32LE(3, 8);
  ["detect", "spoof", "recog"].forEach((name, at) => {
    const entry = 0x10 + at * 64;
    image.write(name, entry, "utf8");
    (name === "recog" ? recogSha : Buffer.alloc(32, at + 1)).copy(image, entry + 24);
  });
  return image;
}

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
  const offers: { deviceId: string; url: string; payload: unknown }[] = [];

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

  function details(token: string, body: object): request.Test {
    return request(http).put("/releases/details").set("Authorization", `Bearer ${token}`).send(body);
  }

  async function until(check: () => Promise<boolean>, what: string): Promise<void> {
    for (let tries = 0; tries < 60; tries += 1) {
      if (await check()) {
        return;
      }
      await new Promise((done) => setTimeout(done, 50));
    }
    assert.fail(`${what} never happened`);
  }

  /** A live heartbeat of any kiosk, applied the way the broker's listener applies it. */
  async function beatOf(deviceId: string, runs: { fwVersion: string; modelVersion: string; onTrial?: boolean }): Promise<void> {
    await app.get(DevicesService).applyHeartbeat(deviceId, { ts: Date.now(), uptimeSeconds: 40, ...runs }, new Date(), true);
  }

  function pathOf(url: string): string {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  }

  async function status(deviceId = BEHIND): Promise<{ state: string; reason: string | null; busyUntil: string | null }> {
    return (await asAdmin("get", `/releases/status/${deviceId}`)).body;
  }

  async function offeredAt(deviceId = BEHIND): Promise<Date> {
    return (await db.device.findUniqueOrThrow({ where: { id: deviceId } })).otaOfferedAt as Date;
  }

  /** A live heartbeat as the kiosk sends it; a build that has no onTrial leaves it out. */
  async function beat(runs: { fwVersion: string; onTrial?: boolean }): Promise<void> {
    const facts = { ts: Date.now(), modelVersion: KIOSK_MODELS, uptimeSeconds: 40, ...runs };
    await app.get(DevicesService).applyHeartbeat(BEHIND, facts, new Date(), true);
  }

  /** An OTA event from the kiosk, through the listener that stores every one the broker hands over. */
  async function report(
    type: "OTA_FAILED" | "OTA_ROLLED_BACK",
    receivedAt: Date,
    said: { cmdId?: string; message?: string; ts?: number },
  ): Promise<void> {
    await app.get(RealtimeListener).onEvent({
      topic: "event",
      deviceId: BEHIND,
      receivedAt,
      payload: { deviceId: BEHIND, ts: receivedAt.getTime(), type, severity: "WARN", ...said },
    });
  }

  /** The kiosk back on the old release, online, with no offer and nothing reported. */
  async function reset(): Promise<void> {
    await db.deviceEvent.deleteMany({ where: { deviceId: BEHIND } });
    await db.device.update({
      where: { id: BEHIND },
      data: { fwVersion: OLDER, fwOnTrial: null, online: true, bootedAt: null, otaReleaseId: null, otaOfferedAt: null },
    });
  }

  async function sweep(): Promise<void> {
    await db.release.deleteMany({ where: { version: { startsWith: "98." } } });
    await db.release.deleteMany({ where: { version: { startsWith: MODELS_PREFIX } } });
    await db.device.deleteMany({ where: { id: { in: [BEHIND, CURRENT, WAITING, MODELS_DOOR, ...CHAIN] } } });
  }

  before(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configure(app);
    await app.init();
    http = app.getHttpServer();
    db = app.get(PrismaService);
    app.get(MqttService).publishDown = async (_name: string, deviceId: string, payload: unknown) => {
      offers.push({ deviceId, url: (payload as { url: string }).url, payload });
    };
    await sweep();
    await db.device.createMany({
      data: [
        { id: BEHIND, status: "APPROVED", fwVersion: OLDER, online: true },
        { id: CURRENT, status: "APPROVED", fwVersion: VERSION, online: true },
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

  it("tells the publisher which versions are already out, so it can skip the build", async () => {
    const ask = (version: string) =>
      request(http)
        .get(`/releases/published?target=FIRMWARE&version=${version}`)
        .set("Authorization", `Bearer ${PUBLISHER}`);
    assert.deepEqual((await ask(VERSION)).body, { published: true });
    assert.deepEqual((await ask("98.9.9")).body, { published: false });
    const stranger = await request(http).get(`/releases/published?target=FIRMWARE&version=${VERSION}`);
    assert.equal(stranger.status, 401, "anybody could read the register");
  });

  it("answers the same version again with the release it has", async () => {
    const again = await publish(`target=FIRMWARE&version=${VERSION}`, appImage(VERSION, 8192));
    assert.equal(again.status, 201);
    assert.equal(again.body.existing, true);
    assert.equal(again.body.release.releaseId, releaseId);
    assert.equal(again.body.release.sizeBytes, image.length, "a second upload replaced the first");
  });

  it("writes the notes of a release in both languages through the publisher's door alone", async () => {
    const said = { target: "FIRMWARE", version: VERSION, notesVi: "- Nhận diện nhanh hơn", notesEn: "- Faster recognition" };
    assert.equal((await details("not-the-publishing-token", said)).status, 401);
    assert.equal((await details(admin, said)).status, 401, "a signed-in admin wrote notes through the machine door");
    const unknown = await details(PUBLISHER, { ...said, version: "98.9.9" });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.message, "RELEASE_NOT_FOUND");
    assert.equal((await details(PUBLISHER, { ...said, notesVi: "" })).status, 400);
    assert.equal((await details(PUBLISHER, { ...said, notesEn: "x".repeat(2001) })).status, 400);
    const stranger = await details(PUBLISHER, { ...said, requiresModels: `${MODELS_PREFIX}9999` });
    assert.equal(stranger.status, 400);
    assert.equal(stranger.body.message, "RELEASE_REQUIRES_INVALID");
    const written = await details(PUBLISHER, said);
    assert.equal(written.status, 200, JSON.stringify(written.body));
    assert.equal(written.body.notesVi, said.notesVi);
    assert.equal(written.body.notesEn, said.notesEn);
    assert.equal(written.body.requiresModels, null);
    assert.equal("summary" in written.body, false, "the leftover columns reached the dashboard");
    const rewritten = await details(PUBLISHER, { ...said, notesVi: "- Nhận diện nhanh hơn nữa" });
    assert.equal(rewritten.body.notesVi, "- Nhận diện nhanh hơn nữa", "a second call left the first notes");
    const fleet = await asAdmin("get", "/releases/fleet");
    const shown = (fleet.body as { release: { releaseId: string; notesVi: string | null; notesEn: string | null } }[]).find(
      (one) => one.release.releaseId === releaseId,
    );
    assert.equal(shown?.release.notesVi, "- Nhận diện nhanh hơn nữa");
    assert.equal(shown?.release.notesEn, said.notesEn);
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

  it("answers no content for a kiosk that was never offered a release", async () => {
    const res = await asAdmin("get", `/releases/status/${CURRENT}`);
    assert.equal(res.status, 204, "a kiosk with no offer still answered 200 with an empty body");
    assert.equal(res.text, "");
    assert.equal((await asAdmin("get", "/releases/status/e2e-rel-nobody")).status, 404);
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
    const checked = otaManifestSchema.safeParse(sent.payload);
    assert.ok(checked.success, `the manifest is outside its contract: ${checked.error?.message}`);
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
    assert.ok(new Date(waiting.body.busyUntil).getTime() > Date.now(), "a fresh offer carries no busy window");

    await db.deviceEvent.create({
      data: {
        deviceId: BEHIND,
        type: "OTA_FAILED",
        severity: "ERROR",
        message: "image does not fit the slot",
        ts: new Date(Date.now() + 1000),
        receivedAt: new Date(Date.now() + 1000),
      },
    });
    const failed = await asAdmin("get", `/releases/status/${BEHIND}`);
    assert.equal(failed.body.state, "FAILED");
    assert.equal(failed.body.reason, "image does not fit the slot");

    await db.device.update({ where: { id: BEHIND }, data: { fwVersion: VERSION } });
    const installed = await asAdmin("get", `/releases/status/${BEHIND}`);
    assert.equal(installed.body.state, "INSTALLED", "a kiosk on the new release still reads as failed");
  });

  it("reads the new release as on trial until the kiosk confirms it, and a build that never says as confirmed", async () => {
    await beat({ fwVersion: VERSION, onTrial: true });
    const trial = await status();
    assert.equal(trial.state, "TRIAL", "a release a reboot would still undo reads as installed");
    assert.equal(trial.busyUntil, null);
    assert.equal((await db.device.findUniqueOrThrow({ where: { id: BEHIND } })).fwOnTrial, true, "the heartbeat's onTrial was not kept");

    await beat({ fwVersion: VERSION, onTrial: false });
    assert.equal((await status()).state, "INSTALLED", "a confirmed release still reads as on trial");

    await beat({ fwVersion: VERSION, onTrial: true });
    await beat({ fwVersion: VERSION });
    const row = await db.device.findUniqueOrThrow({ where: { id: BEHIND } });
    assert.equal(row.fwOnTrial, null, "a build without onTrial kept the trial of the build before it");
    assert.equal((await status()).state, "INSTALLED");
  });

  it("reads a reboot on the old release as interrupted, and a day-old offer as expired", async () => {
    await db.deviceEvent.deleteMany({ where: { deviceId: BEHIND, type: "OTA_FAILED" } });
    // The earlier offer is aged past its busy window, so the kiosk takes a new one.
    await db.device.update({
      where: { id: BEHIND },
      data: { fwVersion: OLDER, bootedAt: new Date(Date.now() - 2 * 3_600_000), otaOfferedAt: new Date(Date.now() - 3_600_000) },
    });
    assert.equal((await asAdmin("post", `/releases/${releaseId}/offer/${BEHIND}`)).status, 201);
    const status = async () => (await asAdmin("get", `/releases/status/${BEHIND}`)).body.state as string;
    assert.equal(await status(), "WAITING", "a kiosk that booted before the offer reads as cut off");

    const offered = (await db.device.findUniqueOrThrow({ where: { id: BEHIND } })).otaOfferedAt as Date;
    await db.device.update({ where: { id: BEHIND }, data: { bootedAt: new Date(offered.getTime() + 20_000) } });
    assert.equal(await status(), "INTERRUPTED", "a kiosk back on the old release still reads as waiting");

    await db.device.update({
      where: { id: BEHIND },
      data: { bootedAt: new Date(offered.getTime() - 25 * 3_600_000), otaOfferedAt: new Date(Date.now() - 25 * 3_600_000) },
    });
    assert.equal(await status(), "EXPIRED", "an offer past its link still reads as waiting");
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

  it("refuses another offer while a kiosk is still installing one, until that ends", async () => {
    offers.length = 0;
    const again = await asAdmin("post", `/releases/${releaseId}/offer/${BEHIND}`);
    assert.equal(again.status, 409, JSON.stringify(again.body));
    assert.equal(again.body.message, "OTA_IN_PROGRESS");
    const all = await asAdmin("post", `/releases/${releaseId}/offer`);
    assert.ok(all.body.busy.includes(BEHIND), "offer-all did not count the installing kiosk apart");
    assert.ok(!all.body.offered.includes(BEHIND), "offer-all offered over a running install");
    assert.equal(offers.filter((one) => one.deviceId === BEHIND).length, 0, "a refused offer still reached the kiosk");
    const fleet = (await asAdmin("get", "/releases/fleet")).body as { release: { releaseId: string }; behind: string[]; updating: string[] }[];
    const firmware = fleet.find((one) => one.release.releaseId === releaseId);
    assert.ok(firmware?.updating.includes(BEHIND), "the installing kiosk is not shown as updating");
    assert.ok(!firmware?.behind.includes(BEHIND), "the installing kiosk still counts toward offer-all");

    const busyMs = validateEnv().OTA_BUSY_MINUTES * 60_000;
    await db.device.update({ where: { id: BEHIND }, data: { otaOfferedAt: new Date(Date.now() - busyMs - 60_000) } });
    const missed = await asAdmin("get", `/releases/status/${BEHIND}`);
    assert.equal(missed.body.state, "WAITING");
    assert.equal(missed.body.busyUntil, null, "an offer past its busy window still locks the kiosk");
    assert.equal((await asAdmin("post", `/releases/${releaseId}/offer/${BEHIND}`)).status, 201, "a missed offer could not be sent again");

    await db.deviceEvent.create({
      data: {
        deviceId: BEHIND,
        type: "OTA_FAILED",
        severity: "ERROR",
        message: "sha256 mismatch",
        ts: new Date(Date.now() + 1000),
        receivedAt: new Date(Date.now() + 1000),
      },
    });
    const failed = await asAdmin("get", `/releases/status/${BEHIND}`);
    assert.equal(failed.body.state, "FAILED");
    assert.equal(failed.body.busyUntil, null, "a kiosk that reported a failure still reads as installing");
    assert.equal((await asAdmin("post", `/releases/${releaseId}/offer/${BEHIND}`)).status, 201, "a failed kiosk could not be offered again");
  });

  it("reads a trial the bootloader undid as rolled back, by the offer it names and when the server heard it", async () => {
    await reset();
    assert.equal((await asAdmin("post", `/releases/${releaseId}/offer/${BEHIND}`)).status, 201);
    const offered = await offeredAt();
    await beat({ fwVersion: VERSION, onTrial: true });
    assert.equal((await status()).state, "TRIAL");

    await db.device.update({
      where: { id: BEHIND },
      data: { fwVersion: OLDER, fwOnTrial: false, bootedAt: new Date(offered.getTime() + 20_000) },
    });
    const kioskTs = offered.getTime() + 60_000;
    await report("OTA_ROLLED_BACK", new Date(offered.getTime() + 1000), { cmdId: randomUUID(), ts: kioskTs });
    await report("OTA_ROLLED_BACK", new Date(offered.getTime() - 1000), { cmdId: releaseId, ts: kioskTs });
    assert.equal((await status()).state, "INTERRUPTED", "a rollback naming another offer, or heard before this one, was taken as this one's");

    await report("OTA_ROLLED_BACK", new Date(offered.getTime() + 2000), { cmdId: releaseId, message: `returned from ${VERSION}` });
    await report("OTA_FAILED", new Date(offered.getTime() + 3000), { cmdId: releaseId, message: "later failure" });
    const back = await status();
    assert.equal(back.state, "ROLLED_BACK", "a rolled-back trial reads as a cut download or a plain failure");
    assert.equal(back.busyUntil, null, "a rolled-back kiosk still reads as installing");
    assert.equal((await asAdmin("post", `/releases/${releaseId}/offer/${BEHIND}`)).status, 201, "a rolled-back kiosk could not be offered again");
  });

  it("shows a second failure within a minute as its own, not as a copy of the first", async () => {
    await reset();
    assert.equal((await asAdmin("post", `/releases/${releaseId}/offer/${BEHIND}`)).status, 201);
    const first = await offeredAt();
    await report("OTA_FAILED", new Date(first.getTime() + 1), { cmdId: releaseId, message: "sha256 mismatch" });
    assert.equal((await status()).reason, "sha256 mismatch");

    assert.equal((await asAdmin("post", `/releases/${releaseId}/offer/${BEHIND}`)).status, 201, "a failed kiosk could not be offered again");
    const second = await offeredAt();
    assert.ok(second.getTime() - first.getTime() < 60_000);
    assert.equal((await status()).state, "WAITING", "the first failure was read as the second offer's");

    await report("OTA_FAILED", new Date(second.getTime() + 1000), { cmdId: releaseId, message: "connection lost" });
    const again = await status();
    assert.equal(again.state, "FAILED");
    assert.equal(again.reason, "connection lost", "the second failure did not show over the first");
    assert.equal(await db.deviceEvent.count({ where: { deviceId: BEHIND, type: "OTA_FAILED" } }), 2, "a failure within a minute of the last was dropped");
  });

  it("will not offer an offline kiosk, which would never hear the offer", async () => {
    await reset();
    await db.device.update({ where: { id: BEHIND }, data: { online: false } });
    offers.length = 0;
    const res = await asAdmin("post", `/releases/${releaseId}/offer/${BEHIND}`);
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(res.body.message, "DEVICE_OFFLINE");
    assert.equal(await offeredAt(), null, "a refused offer still took the kiosk's offer slot");
    assert.equal(offers.length, 0, "an offer went down to an offline kiosk");
  });

  it("leaves offline kiosks out of an offer to all and counts them apart", async () => {
    const fleet = (await asAdmin("get", "/releases/fleet")).body as { release: { releaseId: string }; behind: string[]; offline: string[] }[];
    const firmware = fleet.find((one) => one.release.releaseId === releaseId);
    assert.ok(firmware?.offline.includes(BEHIND), "the offline kiosk is not shown apart");
    assert.ok(!firmware?.behind.includes(BEHIND), "the offline kiosk still counts toward offer-all");

    offers.length = 0;
    const all = await asAdmin("post", `/releases/${releaseId}/offer`);
    assert.equal(all.status, 201, JSON.stringify(all.body));
    assert.ok(all.body.offline.includes(BEHIND), "offer-all did not report the offline kiosk");
    assert.ok(!all.body.offered.includes(BEHIND), "offer-all offered an offline kiosk");
    assert.equal(offers.filter((one) => one.deviceId === BEHIND).length, 0, "an offer went down to an offline kiosk");
    await db.device.update({ where: { id: BEHIND }, data: { online: true } });
  });

  let modelsId = "";

  it("reads the recognition model out of a models image, and turns away a file that is not one", async () => {
    const noise = await publish(`target=MODELS&version=${MODELS_PREFIX}000a&minFwVersion=${OLDER}`, Buffer.alloc(4096, 1));
    assert.equal(noise.status, 400);
    assert.equal(noise.body.message, "RELEASE_NOT_MODELS_IMAGE");
    const res = await publish(`target=MODELS&version=${MODELS_PREFIX}000b&minFwVersion=${OLDER}`, modelsImage(NEW_RECOG));
    assert.equal(res.status, 201, JSON.stringify(res.body));
    modelsId = res.body.release.releaseId as string;
    assert.equal(res.body.release.embeddingVersion, recogName(NEW_RECOG));
  });

  it("moves no single kiosk to another recognition model, and the fleet only on the admin's word", async () => {
    await db.device.create({
      data: {
        id: MODELS_DOOR,
        status: "APPROVED",
        online: true,
        modelVersion: `${MODELS_PREFIX}0009`,
        embeddingVersion: recogName(OLD_RECOG),
      },
    });
    offers.length = 0;
    const one = await asAdmin("post", `/releases/${modelsId}/offer/${MODELS_DOOR}`);
    assert.equal(one.status, 409, JSON.stringify(one.body));
    assert.equal(one.body.message, "RELEASE_CHANGES_RECOGNITION");
    const fleet = (await asAdmin("get", "/releases/fleet")).body as {
      release: { releaseId: string };
      changesRecognition: boolean;
      recapture: string[];
    }[];
    const row = fleet.find((one) => one.release.releaseId === modelsId);
    assert.equal(row?.changesRecognition, true, "the dashboard is not told to ask");
    assert.ok(row?.recapture.includes(MODELS_DOOR), "the kiosk page is not told to hold its own update button");
    const unasked = await asAdmin("post", `/releases/${modelsId}/offer`);
    assert.equal(unasked.status, 409);
    assert.equal(unasked.body.message, "RELEASE_CHANGES_RECOGNITION");
    assert.equal(offers.length, 0, "a recognition change reached a kiosk without the admin's word");
    const told = await asAdmin("post", `/releases/${modelsId}/offer`).send({ recapture: true });
    assert.equal(told.status, 201, JSON.stringify(told.body));
    assert.ok((told.body.offered as string[]).includes(MODELS_DOOR));
  });

  it("offers one kiosk a models release that keeps its recognition model", async () => {
    await db.device.update({
      where: { id: MODELS_DOOR },
      data: { modelVersion: `${MODELS_PREFIX}000b`, embeddingVersion: recogName(NEW_RECOG), otaOfferedAt: null, otaReleaseId: null },
    });
    const next = await publish(`target=MODELS&version=${MODELS_PREFIX}000c&minFwVersion=${OLDER}`, modelsImage(NEW_RECOG));
    assert.equal(next.status, 201, JSON.stringify(next.body));
    const one = await asAdmin("post", `/releases/${next.body.release.releaseId as string}/offer/${MODELS_DOOR}`);
    assert.equal(one.status, 201, JSON.stringify(one.body));
  });

  function kiosk(id: string, fwVersion: string, modelVersion: string) {
    return db.device.create({
      data: { id, status: "APPROVED", online: true, fwVersion, modelVersion, embeddingVersion: recogName(NEW_RECOG) },
    });
  }

  const targetsSent = () => offers.map((one) => (one.payload as { target: string }).target);

  it("refuses a models release that names no firmware to run it", async () => {
    const res = await publish(`target=MODELS&version=${MODELS_PREFIX}00a0`, modelsImage(NEW_RECOG));
    assert.equal(res.status, 400);
    assert.equal(res.body.message, "RELEASE_MIN_FW_REQUIRED");
  });

  it("installs the firmware first when the newest models need it, then the models once it signs off", async () => {
    assert.equal((await publish("target=FIRMWARE&version=98.1.0", appImage("98.1.0"))).status, 201);
    const models = await publish(`target=MODELS&version=${MODELS_PREFIX}00d0&minFwVersion=98.1.0`, modelsImage(NEW_RECOG));
    assert.equal(models.status, 201, JSON.stringify(models.body));
    const crossed = await details(PUBLISHER, {
      target: "FIRMWARE",
      version: "98.1.0",
      notesVi: "- Cần bộ model mới",
      notesEn: "- Needs the new models",
      requiresModels: `${MODELS_PREFIX}00d0`,
    });
    assert.equal(crossed.status, 409, "a firmware and models that need each other first were accepted");
    assert.equal(crossed.body.message, "RELEASE_LOCKSTEP");
    await kiosk(CHAIN[0], VERSION, `${MODELS_PREFIX}000c`);
    offers.length = 0;
    const pressed = await asAdmin("post", `/releases/update/${CHAIN[0]}`);
    assert.equal(pressed.status, 201, JSON.stringify(pressed.body));
    assert.deepEqual(pressed.body.offered, { target: "FIRMWARE", version: "98.1.0" });
    assert.deepEqual(pressed.body.next, { target: "MODELS", version: `${MODELS_PREFIX}00d0` });
    assert.deepEqual(targetsSent(), ["FIRMWARE"]);
    assert.deepEqual((await asAdmin("get", `/releases/status/${CHAIN[0]}`)).body.next, pressed.body.next);
    await beatOf(CHAIN[0], { fwVersion: "98.1.0", modelVersion: `${MODELS_PREFIX}000c`, onTrial: true });
    await new Promise((done) => setTimeout(done, 300));
    assert.deepEqual(targetsSent(), ["FIRMWARE"], "the models went out while the firmware was on trial");
    const fleet = (await asAdmin("get", "/releases/fleet")).body as { release: { target: string }; behind: string[]; updating: string[] }[];
    const newestModels = fleet.find((one) => one.release.target === "MODELS");
    assert.ok(newestModels?.updating.includes(CHAIN[0]), "a kiosk between the two steps of one press read as idle");
    assert.ok(!newestModels?.behind.includes(CHAIN[0]), "an update to all would offer a kiosk between two steps again");
    await beatOf(CHAIN[0], { fwVersion: "98.1.0", modelVersion: `${MODELS_PREFIX}000c`, onTrial: false });
    await until(async () => offers.length === 2, "the queued models offer");
    assert.deepEqual(targetsSent(), ["FIRMWARE", "MODELS"]);
    const row = await db.device.findUniqueOrThrow({ where: { id: CHAIN[0] } });
    assert.equal(row.otaReleaseId, models.body.release.releaseId);
    assert.equal(row.otaNextReleaseId, null, "the step stayed queued after it went out");
    await beatOf(CHAIN[0], { fwVersion: "98.1.0", modelVersion: `${MODELS_PREFIX}000c`, onTrial: false });
    await new Promise((done) => setTimeout(done, 300));
    assert.equal(offers.length, 2, "a second heartbeat offered the models again");
  });

  it("installs the models first when the firmware needs them, then the firmware once they run", async () => {
    const models = await publish(`target=MODELS&version=${MODELS_PREFIX}00e0&minFwVersion=${VERSION}`, modelsImage(NEW_RECOG));
    assert.equal(models.status, 201, JSON.stringify(models.body));
    assert.equal((await publish("target=FIRMWARE&version=98.2.0", appImage("98.2.0"))).status, 201);
    const needs = await details(PUBLISHER, {
      target: "FIRMWARE",
      version: "98.2.0",
      notesVi: "- Cần bộ model mới",
      notesEn: "- Needs the new models",
      requiresModels: `${MODELS_PREFIX}00e0`,
    });
    assert.equal(needs.status, 200, JSON.stringify(needs.body));
    assert.equal(needs.body.requiresModels, `${MODELS_PREFIX}00e0`);
    await kiosk(CHAIN[1], VERSION, `${MODELS_PREFIX}000c`);
    offers.length = 0;
    const pressed = await asAdmin("post", `/releases/update/${CHAIN[1]}`);
    assert.equal(pressed.status, 201, JSON.stringify(pressed.body));
    assert.deepEqual(pressed.body.offered, { target: "MODELS", version: `${MODELS_PREFIX}00e0` });
    assert.deepEqual(pressed.body.next, { target: "FIRMWARE", version: "98.2.0" });
    await beatOf(CHAIN[1], { fwVersion: VERSION, modelVersion: `${MODELS_PREFIX}00e0` });
    await until(async () => offers.length === 2, "the queued firmware offer");
    assert.deepEqual(targetsSent(), ["MODELS", "FIRMWARE"]);
  });

  it("drops the queued step when the first one fails, so nothing follows a broken install", async () => {
    await kiosk(CHAIN[2], VERSION, `${MODELS_PREFIX}000c`);
    offers.length = 0;
    assert.equal((await asAdmin("post", `/releases/update/${CHAIN[2]}`)).status, 201);
    const first = offers[0].payload as { releaseId: string };
    const heardAt = new Date();
    await app.get(RealtimeListener).onEvent({
      topic: "event",
      deviceId: CHAIN[2],
      receivedAt: heardAt,
      payload: { deviceId: CHAIN[2], ts: heardAt.getTime(), type: "OTA_FAILED", severity: "WARN", cmdId: first.releaseId, message: "sha256 mismatch" },
    });
    await beatOf(CHAIN[2], { fwVersion: VERSION, modelVersion: `${MODELS_PREFIX}000c` });
    await until(
      async () => (await db.device.findUniqueOrThrow({ where: { id: CHAIN[2] } })).otaNextReleaseId === null,
      "the queued step dropping",
    );
    assert.equal(offers.length, 1, "the second step went out after the first failed");
  });

  it("finds nothing to install on the newest of both, and refuses models no published firmware runs", async () => {
    await kiosk(CHAIN[3], "98.2.0", `${MODELS_PREFIX}00e0`);
    const current = await asAdmin("post", `/releases/update/${CHAIN[3]}`);
    assert.equal(current.status, 409);
    assert.equal(current.body.message, "RELEASE_ALREADY_RUNNING");
    const ahead = await publish(`target=MODELS&version=${MODELS_PREFIX}00f0&minFwVersion=99.0.0`, modelsImage(NEW_RECOG));
    assert.equal(ahead.status, 409, "models no published firmware runs reached the register");
    assert.equal(ahead.body.message, "RELEASE_FIRMWARE_MISSING");
    const all = await asAdmin("post", "/releases/update").send({});
    assert.equal(all.status, 201, JSON.stringify(all.body));
    assert.ok(!(all.body.offered as string[]).includes(CHAIN[3]), "a kiosk on the newest of both was offered something");
  });

  it("walks a kiosk through an older firmware when the newest two need each other's predecessor", async () => {
    assert.equal((await publish("target=FIRMWARE&version=98.4.0", appImage("98.4.0"))).status, 201);
    const bridge = await publish(`target=MODELS&version=${MODELS_PREFIX}0100&minFwVersion=98.4.0`, modelsImage(NEW_RECOG));
    assert.equal(bridge.status, 201, JSON.stringify(bridge.body));
    assert.equal((await publish("target=FIRMWARE&version=98.5.0", appImage("98.5.0"))).status, 201);
    const needs = await details(PUBLISHER, {
      target: "FIRMWARE",
      version: "98.5.0",
      notesVi: "- Cần bộ model mới",
      notesEn: "- Needs the new models",
      requiresModels: `${MODELS_PREFIX}0100`,
    });
    assert.equal(needs.status, 200, JSON.stringify(needs.body));
    await kiosk(CHAIN[4], "98.2.0", `${MODELS_PREFIX}00e0`);
    offers.length = 0;
    const pressed = await asAdmin("post", `/releases/update/${CHAIN[4]}`);
    assert.equal(pressed.status, 201, JSON.stringify(pressed.body));
    assert.deepEqual(pressed.body.offered, { target: "FIRMWARE", version: "98.4.0" });
    assert.deepEqual(pressed.body.next, { target: "MODELS", version: `${MODELS_PREFIX}0100` });
    const later = await publish(`target=MODELS&version=${MODELS_PREFIX}0200&minFwVersion=98.5.0`, modelsImage(NEW_RECOG));
    assert.equal(later.status, 201, JSON.stringify(later.body));
    await beatOf(CHAIN[4], { fwVersion: "98.4.0", modelVersion: `${MODELS_PREFIX}00e0`, onTrial: false });
    await until(async () => offers.length === 2, "the bridging models offer");
    assert.deepEqual((await asAdmin("get", `/releases/status/${CHAIN[4]}`)).body.next, { target: "FIRMWARE", version: "98.5.0" });
    await beatOf(CHAIN[4], { fwVersion: "98.4.0", modelVersion: `${MODELS_PREFIX}0100` });
    await until(async () => offers.length === 3, "the newest firmware offer");
    const versions = offers.map((one) => (one.payload as { version: string }).version);
    assert.deepEqual(versions, ["98.4.0", `${MODELS_PREFIX}0100`, "98.5.0"]);
    await beatOf(CHAIN[4], { fwVersion: "98.5.0", modelVersion: `${MODELS_PREFIX}0100`, onTrial: false });
    await new Promise((done) => setTimeout(done, 300));
    assert.equal(offers.length, 3, "a release published after the press joined its chain");
  });

  it("refuses a press no order of the releases on the register can satisfy", async () => {
    await db.release.updateMany({ where: { target: "FIRMWARE", version: "98.4.0" }, data: { path: null } });
    await kiosk(CHAIN[5], "98.2.0", `${MODELS_PREFIX}00e0`);
    const stuck = await asAdmin("post", `/releases/update/${CHAIN[5]}`);
    assert.equal(stuck.status, 409, JSON.stringify(stuck.body));
    assert.equal(stuck.body.message, "RELEASE_UNREACHABLE");
  });

  it("tells whoever pressed Update once the kiosk has every step, and only once", async () => {
    const presser = await db.user.findFirstOrThrow({ where: { email: "admin@kiosk.local" }, select: { id: true } });
    await kiosk(CHAIN[6], "98.5.0", `${MODELS_PREFIX}0100`);
    offers.length = 0;
    const pressed = await asAdmin("post", `/releases/update/${CHAIN[6]}`);
    assert.equal(pressed.status, 201, JSON.stringify(pressed.body));
    assert.deepEqual(pressed.body.offered, { target: "MODELS", version: `${MODELS_PREFIX}0200` });
    assert.equal(pressed.body.next, null);
    const held = await db.device.findUniqueOrThrow({ where: { id: CHAIN[6] } });
    assert.equal(held.otaPressedById, presser.id, "a one-step press kept no presser to tell");
    const told = () => db.notification.findMany({ where: { userId: presser.id, kind: "UPDATE_FINISHED", subjectId: CHAIN[6] } });
    await beatOf(CHAIN[6], { fwVersion: "98.5.0", modelVersion: `${MODELS_PREFIX}0200` });
    await until(async () => (await told()).length === 1, "the finished update notice");
    const [notice] = await told();
    assert.equal(notice.subjectType, "DEVICE");
    assert.deepEqual(notice.facts, { firmware: "98.5.0", models: `${MODELS_PREFIX}0200` });
    await beatOf(CHAIN[6], { fwVersion: "98.5.0", modelVersion: `${MODELS_PREFIX}0200` });
    await new Promise((done) => setTimeout(done, 300));
    const again = await told();
    assert.equal(again.length, 1);
    assert.equal(again[0].remindCount, 0, "a second heartbeat told the same finish again");
    assert.equal((await db.device.findUniqueOrThrow({ where: { id: CHAIN[6] } })).otaPressedAt, null);
  });

  it("gives the ADMINs work for a release kiosks lack, and expires it once a newer one arrives", async () => {
    const admin = await db.user.findFirstOrThrow({ where: { email: "admin@kiosk.local" }, select: { id: true } });
    const firmware = await db.release.findUniqueOrThrow({ where: { target_version: { target: "FIRMWARE", version: "98.5.0" } } });
    const workOf = (releaseId: string) => db.noticeItem.findUnique({ where: { key: `releases:${releaseId}` } });
    await until(async () => (await workOf(firmware.releaseId))?.state === "OPEN", "the work of the newest firmware");
    const open = await workOf(firmware.releaseId);
    assert.equal(open?.queue, "RELEASES");
    assert.deepEqual(open?.facts, { target: "FIRMWARE", version: "98.5.0", recognition: false });
    const row = await db.notification.findFirst({ where: { itemId: open?.id, userId: admin.id } });
    assert.equal(row?.kind, "RELEASE_AVAILABLE", "an ADMIN was not told of the release");
    const newer = await publish("target=FIRMWARE&version=98.6.0", appImage("98.6.0"));
    assert.equal(newer.status, 201, JSON.stringify(newer.body));
    await until(async () => (await workOf(firmware.releaseId))?.state === "EXPIRED", "the replaced release's work expiring");
    await until(async () => (await workOf(newer.body.release.releaseId as string))?.state === "OPEN", "the newer release's work");
  });
});
