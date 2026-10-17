import { Injectable, Logger } from "@nestjs/common";

import { PrismaService } from "../../../database/prisma.service.js";
import { holdsAtLeast, recaptureDue } from "../../enrollment/recapture.js";
import { NoticeItemsService } from "../notice-items.service.js";

/** A person's own work while a kiosk they stand on runs a newer recognition model than every face they hold (KEHOACH 9.21.4). */
@Injectable()
export class RecaptureSweep {
  private readonly log = new Logger(RecaptureSweep.name);

  constructor(
    private readonly db: PrismaService,
    private readonly items: NoticeItemsService,
  ) {}

  /** Close the work of whoever no kiosk waits on any more, then open it for whoever one does.
   *  @ctx job | the five-minute kiosk job and the hourly reconcile; `people` keeps a run to them
   */
  async sweep(people: readonly number[] | null = null): Promise<{ opened: number; closed: number }> {
    const closed = await this.closeVanished(people);
    const opened = await this.openMissing(people);
    this.log.log(`recapture swept: ${opened} opened, ${closed} closed`);
    return { opened, closed };
  }

  /** Close DONE once the person holds a set on the model asked for or a newer one, CLEARED otherwise. */
  async closeVanished(people: readonly number[] | null = null): Promise<number> {
    const open = await this.db.noticeItem.findMany({
      where: { queue: "RECAPTURE", state: "OPEN", ...(people ? { employeeId: { in: [...people] } } : {}) },
      select: { subjectId: true, employeeId: true, facts: true },
    });
    if (open.length === 0) {
      return 0;
    }
    const due = new Set((await recaptureDue(this.db, open.map((one) => one.employeeId as number))).map((one) => one.employeeId));
    let closed = 0;
    for (const item of open) {
      const employeeId = item.employeeId as number;
      if (due.has(employeeId)) {
        continue;
      }
      const model = (item.facts as { model?: unknown } | null)?.model;
      const captured = typeof model === "string" && (await holdsAtLeast(this.db, employeeId, model));
      const closing = captured ? { state: "DONE" as const, outcome: "COMPLETED" as const } : { state: "CLEARED" as const };
      if (await this.items.close("RECAPTURE", item.subjectId, closing)) {
        closed += 1;
      }
    }
    return closed;
  }

  /** Open one item per person a kiosk waits on, naming the newest model it asks for; open work is left alone. */
  async openMissing(people: readonly number[] | null = null): Promise<number> {
    const due = await recaptureDue(this.db, people);
    const wanted = new Map<number, string>();
    for (const one of due) {
      if (!wanted.has(one.employeeId)) {
        wanted.set(one.employeeId, one.model);
      }
    }
    if (wanted.size === 0) {
      return 0;
    }
    const held = await this.db.noticeItem.findMany({
      where: { queue: "RECAPTURE", state: "OPEN", employeeId: { in: [...wanted.keys()] } },
      select: { employeeId: true },
    });
    const told = new Set(held.map((one) => one.employeeId));
    let opened = 0;
    for (const [employeeId, model] of wanted) {
      if (told.has(employeeId)) {
        continue;
      }
      if (await this.items.open("RECAPTURE", { id: String(employeeId), employeeId }, { facts: { model } })) {
        opened += 1;
      }
    }
    return opened;
  }
}
