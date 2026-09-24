import { Inject, Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import { ALARM } from "../../common/cache/cache-keys.js";
import type { Env } from "../../config/env.schema.js";
import { PrismaService } from "../../database/prisma.service.js";
import { RedisService } from "../../database/redis.service.js";
import { QUEUE_TOKEN, type Queues } from "../../queue/queue.module.js";
import { QUEUE } from "../../queue/queues.js";
import { backupAlarmMail, DEFAULT_MAIL_LOCALE, type BackupProblem } from "../payroll/mail-text.js";
import { MailerService } from "./mailer.service.js";

/** What pg_stat_archiver says about the last push either way. */
export interface ArchiverState {
  lastArchivedAt: Date | null;
  lastFailedAt: Date | null;
  lastFailedWal: string | null;
}

export interface BackupFinding {
  problem: BackupProblem;
  lastGood: Date | null;
  detail: string | null;
}

// Each kind backup.sh writes to ops.backup_run, and what its absence is called.
const CHAINS: ReadonlyArray<readonly [string, BackupProblem]> = [
  ["dump", "DUMP_STALE"],
  ["biometric", "BIOMETRIC_STALE"],
  ["base", "BASE_STALE"],
  ["wal", "WAL_STALE"],
];
const PROBLEMS: readonly BackupProblem[] = ["WAL_FAILING", ...CHAINS.map(([, problem]) => problem)];
const kWatchCron = "*/15 * * * *";
const kRemindSeconds = 86_400;
const kHourMs = 3_600_000;

/** Everything wrong with the backups at `now`, given the newest run of each chain. */
export function judgeBackups(
  archiver: ArchiverState,
  newest: ReadonlyMap<string, Date>,
  now: Date,
  staleHours: number,
): BackupFinding[] {
  const found: BackupFinding[] = [];
  const { lastArchivedAt, lastFailedAt } = archiver;
  if (lastFailedAt && (!lastArchivedAt || lastFailedAt > lastArchivedAt)) {
    found.push({ problem: "WAL_FAILING", lastGood: lastArchivedAt, detail: archiver.lastFailedWal });
  }
  for (const [kind, problem] of CHAINS) {
    const at = newest.get(kind) ?? null;
    if (!at || now.getTime() - at.getTime() > staleHours * kHourMs) {
      found.push({ problem, lastGood: at, detail: null });
    }
  }
  return found;
}

@Injectable()
export class BackupWatchService implements OnModuleInit {
  private readonly log = new Logger(BackupWatchService.name);

  constructor(
    private readonly db: PrismaService,
    private readonly redis: RedisService,
    private readonly mailer: MailerService,
    private readonly config: ConfigService<Env, true>,
    @Inject(QUEUE_TOKEN) private readonly queues: Queues,
  ) {}

  // Upserting by scheduler id: a restart re-states it, never adds a second.
  async onModuleInit(): Promise<void> {
    await this.queues[QUEUE.notify].upsertJobScheduler(
      "backup-watch",
      { pattern: kWatchCron },
      { name: "backup-watch", data: { type: "backup-watch" } },
    );
  }

  /** Mail every active ADMIN about each problem found, once a day while it lasts. */
  async sweep(): Promise<{ problems: BackupProblem[] }> {
    const staleHours = this.config.get("BACKUP_STALE_HOURS", { infer: true });
    if (staleHours === 0) {
      return { problems: [] };
    }
    const [archiver] = await this.db.$queryRaw<ArchiverState[]>`
      SELECT last_archived_time AS "lastArchivedAt",
             last_failed_time AS "lastFailedAt",
             last_failed_wal AS "lastFailedWal"
        FROM pg_stat_archiver
    `;
    const now = new Date();
    const found = judgeBackups(archiver, await this.newestRuns(), now, staleHours);
    const failing = new Set(found.map((one) => one.problem));
    for (const problem of PROBLEMS.filter((one) => !failing.has(one))) {
      await this.redis.client.del(ALARM.backup(problem));
    }
    for (const finding of found) {
      await this.raise(finding, now);
    }
    return { problems: [...failing] };
  }

  private async newestRuns(): Promise<Map<string, Date>> {
    // backup.sh makes the table on its first night, so a box that never ran one has none.
    const [held] = await this.db.$queryRaw<{ present: boolean }[]>`
      SELECT to_regclass('ops.backup_run') IS NOT NULL AS "present"
    `;
    if (!held.present) {
      return new Map();
    }
    const rows = await this.db.$queryRaw<{ kind: string; at: Date }[]>`
      SELECT kind, max(finished_at) AS "at" FROM ops.backup_run GROUP BY kind
    `;
    return new Map(rows.map((row) => [row.kind, row.at]));
  }

  private async raise(finding: BackupFinding, now: Date): Promise<void> {
    const key = ALARM.backup(finding.problem);
    if (await this.redis.client.exists(key)) {
      return;
    }
    const admins = await this.db.user.findMany({
      where: { role: "ADMIN", active: true },
      select: { email: true },
      orderBy: { email: "asc" },
    });
    const body = backupAlarmMail(DEFAULT_MAIL_LOCALE, {
      problem: finding.problem,
      checkedAt: this.local(now),
      lastGood: finding.lastGood ? this.local(finding.lastGood) : null,
      detail: finding.detail,
    });
    // One address refusing must neither silence the rest nor make the retry resend to them.
    let reached = 0;
    let delivered = 0;
    for (const admin of admins) {
      try {
        delivered += (await this.mailer.send(admin.email, body)) ? 1 : 0;
        reached += 1;
      } catch (error) {
        this.log.error(`backup ${finding.problem}: ${admin.email} refused: ${(error as Error).message}`);
      }
    }
    this.log.warn(
      `backup ${finding.problem}: ${delivered} of ${admins.length} admin(s) mailed, ${reached - delivered} only logged`,
    );
    if (admins.length > 0 && reached === 0) {
      return;
    }
    await this.redis.client.set(key, now.toISOString(), "EX", kRemindSeconds);
  }

  private local(at: Date): string {
    const zone = this.config.get("APP_TIMEZONE", { infer: true });
    return `${at.toLocaleString("sv-SE", { timeZone: zone })} (${zone})`;
  }
}
