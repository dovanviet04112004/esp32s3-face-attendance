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
const { hashPassword } = await import("../src/modules/auth/password.js");
const { EnrollmentService } = await import("../src/modules/enrollment/enrollment.service.js");
const { MailerService } = await import("../src/modules/notifications/mailer.service.js");
const { BackupWatchService, judgeBackups } = await import(
  "../src/modules/notifications/backup-watch.service.js"
);

const PROBLEMS: BackupProblem[] = [
  "WAL_FAILING",
  "DUMP_STALE",
  "BIOMETRIC_STALE",
  "BASE_STALE",
  "WAL_STALE",
  "OFFSITE_STALE",
];
const CHAINS = ["dump", "biometric", "base", "wal", "offsite"];
const OPERATOR = "e2e-backup-watch@kiosk.local";
const CODE = "E2EBKP01";
const kHourMs = 3_600_000;

describe("backups (e2e)", () => {
  let app: INestApplication;
  let db: InstanceType<typeof PrismaService>;
  let redis: InstanceType<typeof RedisService>;
  let watch: InstanceType<typeof BackupWatchService>;
  let operatorId = "";
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

  async function forget(kind: string): Promise<void> {
    await db.$executeRaw`DELETE FROM ops.backup_run WHERE kind = ${kind}`;
  }

  /** What reached the ADMIN this suite owns; every other letter is dropped with it. */
  function toOperator(): MailBody[] {
    return sent
      .splice(0)
      .filter((one) => one.to === OPERATOR)
      .map((one) => one.body);
  }

  async function sweep(): Promise<BackupProblem[]> {
    return (await watch.sweep()).problems.sort();
  }

  async function sweepAway(): Promise<void> {
    await db.user.deleteMany({ where: { email: OPERATOR } });
    await db.employee.deleteMany({ where: { code: CODE } });
    for (const problem of PROBLEMS) {
      await redis.client.del(ALARM.backup(problem));
    }
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
    await sweepAway();
    const operator = await db.user.create({
      data: { email: OPERATOR, role: "ADMIN", passwordHash: await hashPassword("e2e-backup-watch-password") },
    });
    operatorId = operator.id;
  });

  after(async () => {
    await sweepAway();
    await app.close();
  });

  it("counts a box that never ran a backup as every chain stale", async () => {
    await db.$executeRawUnsafe("DROP TABLE IF EXISTS ops.backup_run");
    assert.deepEqual(await sweep(), ["BASE_STALE", "BIOMETRIC_STALE", "DUMP_STALE", "OFFSITE_STALE", "WAL_STALE"]);
    const letters = toOperator().map((one) => one.subject);
    assert.equal(letters.length, 5, "each problem reaches the ADMIN once");
    assert.equal(new Set(letters).size, 5, letters.join(" | "));
  });

  it("stays quiet once every chain has a fresh run, and forgets what it said", async () => {
    await makeTable();
    for (const kind of CHAINS) {
      await ran(kind, 1);
    }
    assert.deepEqual(await sweep(), []);
    assert.equal(toOperator().length, 0, "a healthy sweep sent mail");
    for (const problem of PROBLEMS) {
      assert.equal(await redis.client.exists(ALARM.backup(problem)), 0, `${problem} is still marked as told`);
    }
  });

  it("mails the ADMINs when one chain goes stale, and not again the same day", async () => {
    await forget("base");
    await ran("base", 27);
    assert.deepEqual(await sweep(), ["BASE_STALE"]);
    assert.equal(toOperator().length, 1);
    assert.deepEqual(await sweep(), ["BASE_STALE"]);
    assert.equal(toOperator().length, 0, "the same stale chain was mailed twice within a day");
  });

  it("mails again when a chain that recovered goes stale a second time", async () => {
    await ran("base", 0);
    assert.deepEqual(await sweep(), []);
    await forget("base");
    await ran("base", 30);
    assert.deepEqual(await sweep(), ["BASE_STALE"]);
    const letters = toOperator();
    assert.equal(letters.length, 1, "a second outage went unsaid");
    assert.match(letters[0].subject, /bản gốc vật lý/);
  });

  it("keeps telling the others when one address refuses", async () => {
    const mailer = app.get(MailerService);
    const quiet = mailer.send;
    mailer.send = async (to: string, body: MailBody) => {
      if (to !== OPERATOR) {
        throw new Error("550 mailbox unavailable");
      }
      sent.push({ to, body });
      return true;
    };
    try {
      await redis.client.del(ALARM.backup("BASE_STALE"));
      assert.deepEqual(await sweep(), ["BASE_STALE"]);
      assert.equal(toOperator().length, 1, "a refusing address silenced the next one");
      assert.equal(await redis.client.exists(ALARM.backup("BASE_STALE")), 1, "one letter out still counts as told");
    } finally {
      mailer.send = quiet;
    }
  });

  it("calls the offsite copy stale while every chain on the VPS is fresh", async () => {
    await ran("base", 0);
    await forget("offsite");
    await ran("offsite", 27);
    assert.deepEqual(await sweep(), ["OFFSITE_STALE"]);
    const letters = toOperator();
    assert.equal(letters.length, 1, "a copy missing off the VPS went unsaid");
    assert.match(letters[0].subject, /bản ngoài máy/);
    await ran("offsite", 0);
    assert.deepEqual(await sweep(), []);
  });

  it("rewrites FaceTemplate when a face is erased, so no page keeps the old bytes", async () => {
    const template = await db.employee.findFirstOrThrow({
      where: { active: true, legalEntityId: { not: null } },
    });
    const person = await db.employee.create({
      data: { code: CODE, fullName: "Xoá mặt thử", active: true, legalEntityId: template.legalEntityId },
    });
    await db.faceTemplate.create({
      data: {
        employeeId: person.id,
        templateIdx: 0,
        embedding: Buffer.alloc(512, 7),
        scale: 1,
        capturedAt: new Date(),
      },
    });
    const node = async () =>
      (await db.$queryRaw<{ node: number }[]>`SELECT pg_relation_filenode('"FaceTemplate"')::int AS "node"`)[0].node;
    const held = await node();
    await app.get(EnrollmentService).erase(person.id, operatorId, "e2e");
    assert.notEqual(await node(), held, "the table kept its file, dead tuple and all");
    assert.equal(await db.faceTemplate.count({ where: { employeeId: person.id } }), 0);
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
