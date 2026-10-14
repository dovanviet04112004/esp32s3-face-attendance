import { Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import type { Device, Release } from "@prisma/client";

import { PrismaService } from "../../../database/prisma.service.js";
import {
  behind,
  changesRecognition,
  PUBLISHED_TARGETS,
  RELEASE_PUBLISHED,
  UPDATE_FINISHED,
  type ReleasePublished,
  type UpdateFinished,
} from "../../models/release-rules.js";
import { itemKey, NoticeItemsService, type Closing } from "../notice-items.service.js";
import { NotificationsService } from "../notifications.service.js";

type Runs = Pick<Device, "fwVersion" | "modelVersion" | "embeddingVersion">;

/** A release's work for the ADMINs while approved kiosks run something older, and the presser's word that an
 *  update is in (KEHOACH 9.21.4).
 */
@Injectable()
export class ReleaseSweep {
  private readonly log = new Logger(ReleaseSweep.name);

  constructor(
    private readonly db: PrismaService,
    private readonly items: NoticeItemsService,
    private readonly notices: NotificationsService,
  ) {}

  @OnEvent(RELEASE_PUBLISHED)
  async onPublished(published: ReleasePublished): Promise<void> {
    await this.sweep().catch((error: Error) => this.log.error(`release ${published.releaseId} was not told: ${error.message}`));
  }

  @OnEvent(UPDATE_FINISHED)
  async onFinished(done: UpdateFinished): Promise<void> {
    await this.notices.raise(done.actorId, "UPDATE_FINISHED", { deviceId: done.deviceId, firmware: done.firmware, models: done.models });
  }

  /** Close the work the fleet has taken or a newer release replaced, then open it for the newest release of each
   *  kind some approved kiosk still lacks.
   *  @ctx job | every publish, the five-minute kiosk job and the hourly reconcile
   */
  async sweep(): Promise<{ opened: number; closed: number }> {
    const closed = await this.closeVanished();
    const opened = await this.openMissing();
    return { opened, closed };
  }

  /** Close each open release item whose kiosks have all taken it, or whose release a newer one replaced. */
  async closeVanished(): Promise<number> {
    const open = await this.db.noticeItem.findMany({ where: { queue: "RELEASES", state: "OPEN" }, select: { subjectId: true } });
    if (open.length === 0) {
      return 0;
    }
    const [held, fleet, newest] = await Promise.all([
      this.db.release.findMany({ where: { releaseId: { in: open.map((one) => one.subjectId) } } }),
      this.fleet(),
      this.newest(),
    ]);
    let closed = 0;
    for (const item of open) {
      const release = held.find((one) => one.releaseId === item.subjectId);
      const replaced = !release || newest.get(release.target)?.releaseId !== release.releaseId;
      const closing: Closing | null = replaced
        ? { state: "EXPIRED" }
        : fleet.some((one) => behind(one, release))
          ? null
          : { state: "DONE", outcome: "COMPLETED" };
      if (closing && (await this.items.close("RELEASES", item.subjectId, closing))) {
        closed += 1;
      }
    }
    return closed;
  }

  /** Open the work of the newest release of each kind while approved kiosks run something older; told once. */
  async openMissing(): Promise<number> {
    const [fleet, newest] = await Promise.all([this.fleet(), this.newest()]);
    let opened = 0;
    for (const release of newest.values()) {
      const lagging = fleet.filter((one) => behind(one, release));
      if (lagging.length === 0) {
        continue;
      }
      const told = await this.db.noticeItem.findUnique({ where: { key: itemKey("RELEASES", release.releaseId) }, select: { id: true } });
      if (told) {
        continue;
      }
      const facts = {
        target: release.target,
        version: release.version,
        recognition: lagging.some((one) => changesRecognition(one, release)),
      };
      if (await this.items.open("RELEASES", { id: release.releaseId, employeeId: null }, { facts })) {
        opened += 1;
      }
    }
    return opened;
  }

  private fleet(): Promise<Runs[]> {
    return this.db.device.findMany({
      where: { status: "APPROVED" },
      select: { fwVersion: true, modelVersion: true, embeddingVersion: true },
    });
  }

  private async newest(): Promise<Map<string, Release>> {
    const found = await Promise.all(
      PUBLISHED_TARGETS.map((target) =>
        this.db.release.findFirst({ where: { target, path: { not: null } }, orderBy: { createdAt: "desc" } }),
      ),
    );
    return new Map(found.filter((one): one is Release => one !== null).map((one) => [one.target, one]));
  }
}
