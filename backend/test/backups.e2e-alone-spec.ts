import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";

import type { BackupProblem, MailBody } from "../src/modules/payroll/mail-text.js";

// The config module validates at import, so the watch is switched on ahead of loading the app.
process.env.BACKUP_STALE_HOURS = "26";
const { AppModule } = await import("../src/app.module.js");
const { configure } = await import("../src/bootstrap.js");
const { ALARM } = await import("../src/common/cache/cache-keys.js");
const { PrismaService } = await import("../src/database/prisma.service.js");
const { RedisService } = await import("../src/database/redis.service.js");
const { MailerService } = await import("../src/modules/notifications/mailer.service.js");
const { BackupWatchService, judgeBackups } = await import(
  "../src/modules/notifications/backup-watch.service.js"
);

const PROBLEMS: BackupProblem[] = ["WAL_FAILING", "DUMP_STALE", "BIOMETRIC_STALE", "BASE_STALE", "WAL_STALE"];
const CHAINS = ["dump", "biometric", "base", "wal"];
const kHourMs = 3_600_000;

describe("backup watch (e2e)", () => {
  let app: INestApplication;
  let db: InstanceType<typeof PrismaService>;
  let redis: InstanceType<typeof RedisService>;
  let watch: InstanceType<typeof BackupWatchService>;
  let admins: string[] = [];
  const sent: { to: string; body: MailBody }[] = [];

  async function makeTable(): Promise<void> {
    await db.$executeRawUnsafe("CREATE SCHEMA IF NOT EXISTS ops");
    await db.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS ops.backup_run (
        finished_at timestamptz NOT NULL DEFAULT now(),
        kind        text        NOT NULL,
        bytes       bigint      NOT NULL,
        PRIMARY KEY (finished_at, kind)
      )`);
  }

  async function ran(kind: string, hoursAgo: number): Promise<void> {
    await db.$executeRaw`
      INSERT INTO ops.backup_run (finished_at, kind, bytes)
      VALUES (now() - make_interval(secs => ${hoursAgo * 3600}), ${kind}, 1)
    `;
  }

  async function forget(kind?: string): Promise<void> {
    if (kind) {
      await db.$executeRaw`DELETE FROM ops.backup_run WHERE kind = ${kind}`;
    } else {
      await db.$executeRaw`DELETE FROM ops.backup_run`;
    }
  }

  function mailed(): string[] {
    return sent.splice(0).map((one) => one.to).sort();
  }

  before(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configure(app);
    await app.init();
    db = app.get(PrismaService);
    redis = app.get(RedisService);
    watch = app.get(BackupWatchService);
    const mailer = app.get(MailerService);
    mailer.send = async (to: string, body: MailBody) => {
      sent.push({ to, body });
      return true;
    };
    const held = await db.user.findMany({ where: { role: "ADMIN", active: true }, select: { email: true } });
    admins = held.map((one) => one.email).sort();
    assert.ok(admins.length > 0, "the seed made no active ADMIN to mail");
    for (const problem of PROBLEMS) {
      await redis.client.del(ALARM.backup(problem));
    }
  });

  after(async () => {
    for (const problem of PROBLEMS) {
      await redis.client.del(ALARM.backup(problem));
    }
    await app.close();
  });

  it("counts a box that never ran a backup as every chain stale", async () => {
    await db.$executeRawUnsafe("DROP TABLE IF EXISTS ops.backup_run");
    const { problems } = await watch.sweep();
    assert.deepEqual(problems.sort(), ["BASE_STALE", "BIOMETRIC_STALE", "DUMP_STALE", "WAL_STALE"]);
    assert.equal(mailed().length, admins.length * 4, "each problem reaches each ADMIN once");
  });

  it("stays quiet once every chain has a fresh run, and forgets what it said", async () => {
    await makeTable();
    for (const kind of CHAINS) {
      await ran(kind, 1);
    }
    assert.deepEqual((await watch.sweep()).problems, []);
    assert.deepEqual(mailed(), []);
    for (const problem of PROBLEMS) {
      assert.equal(await redis.client.exists(ALARM.backup(problem)), 0, `${problem} is still marked as told`);
    }
  });

  it("mails every active ADMIN when one chain goes stale, and not again the same day", async () => {
    await forget("base");
    await ran("base", 27);
    assert.deepEqual((await watch.sweep()).problems, ["BASE_STALE"]);
    assert.deepEqual(mailed(), admins);
    assert.deepEqual((await watch.sweep()).problems, ["BASE_STALE"]);
    assert.deepEqual(mailed(), [], "the same stale chain was mailed twice within a day");
  });

  it("mails again when a chain that recovered goes stale a second time", async () => {
    await ran("base", 0);
    assert.deepEqual((await watch.sweep()).problems, []);
    await forget("base");
    await ran("base", 30);
    assert.deepEqual((await watch.sweep()).problems, ["BASE_STALE"]);
    const letters = sent.map((one) => one.body.subject);
    assert.deepEqual(mailed(), admins, "a second outage went unsaid");
    assert.ok(letters.every((subject) => subject.includes("bản gốc vật lý")), letters.join(" | "));
  });

  it("calls the archive failing only while its last push failed", () => {
    const now = new Date();
    const fresh = new Map(CHAINS.map((kind) => [kind, now]));
    const earlier = new Date(now.getTime() - kHourMs);
    const failing = judgeBackups(
      { lastArchivedAt: earlier, lastFailedAt: now, lastFailedWal: "000000010000000000000009" },
      fresh,
      now,
      26,
    );
    assert.deepEqual(failing, [{ problem: "WAL_FAILING", lastGood: earlier, detail: "000000010000000000000009" }]);
    const recovered = judgeBackups(
      { lastArchivedAt: now, lastFailedAt: earlier, lastFailedWal: "000000010000000000000009" },
      fresh,
      now,
      26,
    );
    assert.deepEqual(recovered, []);
    const neverPushed = judgeBackups({ lastArchivedAt: null, lastFailedAt: now, lastFailedWal: null }, fresh, now, 26);
    assert.equal(neverPushed[0]?.problem, "WAL_FAILING");
  });

  it("holds a chain fresh up to its limit and stale one millisecond past it", () => {
    const now = new Date();
    const archiver = { lastArchivedAt: null, lastFailedAt: null, lastFailedWal: null };
    const at = (hours: number, extraMs = 0) => new Date(now.getTime() - hours * kHourMs - extraMs);
    const edge = new Map(CHAINS.map((kind) => [kind, at(26)]));
    assert.deepEqual(judgeBackups(archiver, edge, now, 26), []);
    const past = new Map(CHAINS.map((kind) => [kind, kind === "wal" ? at(26, 1) : at(26)]));
    assert.deepEqual(
      judgeBackups(archiver, past, now, 26).map((one) => one.problem),
      ["WAL_STALE"],
    );
  });
});
