import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Employee, Prisma, ProfileChange } from "@prisma/client";

import { COUNT_CEILING, countedTo, nextCursor } from "../../common/dto/cursor.dto.js";
import type { Page } from "../../common/dto/pagination.dto.js";
import { ScopeService } from "../../common/scope/scope.service.js";
import type { Viewer } from "../../common/scope/viewer.js";
import type { Env } from "../../config/env.schema.js";
import { PrismaService } from "../../database/prisma.service.js";
import { QUEUE_TOKEN, type Queues } from "../../queue/queue.module.js";
import { JOB, QUEUE, type ProfileNoticeJob } from "../../queue/queues.js";
import { AUDIT_ACTIONS, AUDIT_SUBJECTS } from "../audit/audit-actions.js";
import { AuditService } from "../audit/audit.service.js";
import {
  PERSON_VIEW,
  QUEUE_DESKS,
  filedBetween,
  notOwnWaiting,
  personWhere,
  resumeAfter,
  sortedBy,
  waitedDays,
  whoseRows,
} from "../leave/queue-filter.js";
import { MailerService } from "../notifications/mailer.service.js";
import { NotificationsService } from "../notifications/notifications.service.js";
import { profileNoticeMail } from "../payroll/mail-text.js";
import {
  PROFILE_FIELDS,
  askedValues,
  heldValues,
  sameValues,
  type ProfileValues,
} from "./profile-fields.js";
import type {
  AskProfileChangeDto,
  DecideProfileChangeDto,
  ListProfileChangesDto,
} from "./dto/profile-change.dto.js";

const DESK = QUEUE_DESKS.profileChanges;

type Person = Employee & { login: { email: string } | null };

type Listed = Prisma.ProfileChangeGetPayload<{ include: { employee: typeof PERSON_VIEW } }>;

export interface ProfileChangeRow extends Listed {
  waitedDays: number;
}

@Injectable()
export class ProfileService {
  private readonly log = new Logger(ProfileService.name);

  constructor(
    private readonly db: PrismaService,
    private readonly scope: ScopeService,
    private readonly audit: AuditService,
    private readonly mailer: MailerService,
    private readonly notices: NotificationsService,
    private readonly config: ConfigService<Env, true>,
    @Inject(QUEUE_TOKEN) private readonly queues: Queues,
  ) {}

  /** Ask for one change to one record. Anybody may ask for their own; the
   *  desk may ask on somebody's behalf and then cannot decide it.
   */
  async ask(viewer: Viewer, body: AskProfileChangeDto): Promise<ProfileChange> {
    const employeeId = body.employeeId ?? viewer.employeeId;
    if (employeeId === null || employeeId === undefined) {
      throw new ForbiddenException("NO_EMPLOYEE_RECORD");
    }
    if (employeeId !== viewer.employeeId && !DESK.includes(viewer.role)) {
      throw new ForbiddenException("HR_ONLY");
    }
    const person = await this.reachable(viewer, employeeId);
    const want = askedValues(body.field, body);
    if (want === null) {
      throw new BadRequestException("PROFILE_FIELD_EMPTY");
    }
    const held = heldValues(person, body.field);
    if (sameValues(held, want)) {
      throw new BadRequestException("PROFILE_NO_CHANGE");
    }
    const waiting = await this.db.profileChange.count({
      where: { employeeId, field: body.field, state: "PENDING" },
    });
    if (waiting > 0) {
      throw new ConflictException("PROFILE_CHANGE_PENDING");
    }
    const made = await this.db.profileChange.create({
      data: {
        employeeId,
        field: body.field,
        oldValue: held as Prisma.InputJsonObject,
        newValue: want as Prisma.InputJsonObject,
        reason: body.reason ?? null,
        askedById: viewer.userId,
        noticeTo: PROFILE_FIELDS[body.field].notice === null ? null : this.addressOf(person),
      },
    });
    await this.audit.record({
      actorId: viewer.userId,
      action: AUDIT_ACTIONS.PROFILE_ASK,
      subject: AUDIT_SUBJECTS.EMPLOYEE,
      subjectId: String(employeeId),
      meta: { field: body.field },
    });
    await this.notices.raiseToDesk(DESK, "REQUEST_WAITING", { profileChangeId: made.id }, {
      employeeIds: [employeeId],
      userIds: [viewer.userId],
    });
    return made;
  }

  async list(viewer: Viewer, query: ListProfileChangesDto): Promise<Page<ProfileChangeRow>> {
    const visible = await this.scope.deskOrSelfEmployeeIds(viewer);
    const person = await personWhere(this.db, query);
    const waiting = query.state === "PENDING";
    // Every clause names employeeId, so an AND keeps the narrowest rather than letting one replace another.
    const where = {
      AND: [
        whoseRows(visible, query.employeeId),
        notOwnWaiting(viewer, DESK, waiting, query.employeeId),
        query.state ? { state: query.state } : {},
        query.field ? { field: query.field } : {},
        person ? { employee: person } : {},
        filedBetween("createdAt", query, this.config.get("APP_TIMEZONE", { infer: true })),
      ],
    } as Prisma.ProfileChangeWhereInput;
    const order = query.order ?? (waiting ? "asc" : "desc");
    const resumed = query.cursor
      ? { AND: [where, resumeAfter("createdAt", order, query.cursor) as Prisma.ProfileChangeWhereInput] }
      : where;
    const [rows, found] = await Promise.all([
      this.db.profileChange.findMany({
        where: resumed,
        skip: query.cursor ? 0 : query.skip,
        take: query.take,
        orderBy: sortedBy("createdAt", order) as Prisma.ProfileChangeOrderByWithRelationInput[],
        include: { employee: PERSON_VIEW },
      }),
      this.db.profileChange.count({ where, take: COUNT_CEILING + 1 }),
    ]);
    const now = new Date();
    return {
      rows: rows.map((row) => ({ ...row, waitedDays: waitedDays(row.createdAt, now) })),
      ...countedTo(found),
      next: nextCursor(rows, query.take, (row) => row.createdAt),
    };
  }

  /** Write the change into the record. The period already locked keeps the
   *  destination it copied, so this takes effect at once (KEHOACH 9.6).
   */
  async approve(viewer: Viewer, id: string): Promise<ProfileChange> {
    const held = await this.decidable(viewer, id);
    const asked = held.newValue as ProfileValues;
    // Rebuilt from the declared columns rather than spread: a row carrying a
    // stray key writes nothing extra (KEHOACH 9.17 item 6 rule 1).
    const write: ProfileValues = {};
    for (const column of PROFILE_FIELDS[held.field].columns) {
      write[column] = asked[column] ?? null;
    }
    const given = await this.db.$transaction(async (tx) => {
      await this.claim(tx, held.id, { state: "APPROVED", decidedAt: new Date(), decidedById: viewer.userId });
      await tx.employee.update({ where: { id: held.employeeId }, data: write });
      return tx.profileChange.findUniqueOrThrow({ where: { id: held.id } });
    });
    await this.audit.record({
      actorId: viewer.userId,
      action: AUDIT_ACTIONS.PROFILE_APPROVE,
      subject: AUDIT_SUBJECTS.EMPLOYEE,
      subjectId: String(held.employeeId),
      meta: { field: held.field, noticeTo: held.noticeTo },
    });
    if (PROFILE_FIELDS[held.field].notice !== null && held.noticeTo !== null) {
      await this.queues[QUEUE.notify].add(JOB.profileNotice, {
        type: "profile-notice",
        changeId: held.id,
      } satisfies ProfileNoticeJob);
    }
    this.log.log(`profile ${held.field} changed for employee ${held.employeeId}`);
    await this.notices.raiseFor(held.employeeId, "REQUEST_DECIDED", { profileChangeId: held.id, approved: true });
    return given;
  }

  async reject(viewer: Viewer, id: string, body: DecideProfileChangeDto): Promise<ProfileChange> {
    const held = await this.decidable(viewer, id);
    const turned = await this.db.$transaction(async (tx) => {
      await this.claim(tx, held.id, {
        state: "REJECTED",
        note: body.note ?? null,
        decidedAt: new Date(),
        decidedById: viewer.userId,
      });
      return tx.profileChange.findUniqueOrThrow({ where: { id: held.id } });
    });
    await this.audit.record({
      actorId: viewer.userId,
      action: AUDIT_ACTIONS.PROFILE_REJECT,
      subject: AUDIT_SUBJECTS.EMPLOYEE,
      subjectId: String(held.employeeId),
      meta: { field: held.field, note: body.note ?? null },
    });
    await this.notices.raiseFor(held.employeeId, "REQUEST_DECIDED", { profileChangeId: held.id, approved: false });
    return turned;
  }

  /** Take back a change nobody has answered yet. */
  async cancel(viewer: Viewer, id: string): Promise<ProfileChange> {
    const held = await this.waiting(id);
    if (held.employeeId !== viewer.employeeId && held.askedById !== viewer.userId) {
      throw new ForbiddenException("PROFILE_NOT_YOURS");
    }
    const dropped = await this.db.$transaction(async (tx) => {
      await this.claim(tx, held.id, { state: "CANCELLED", decidedAt: new Date() });
      return tx.profileChange.findUniqueOrThrow({ where: { id: held.id } });
    });
    await this.audit.record({
      actorId: viewer.userId,
      action: AUDIT_ACTIONS.PROFILE_CANCEL,
      subject: AUDIT_SUBJECTS.EMPLOYEE,
      subjectId: String(held.employeeId),
      meta: { field: held.field },
    });
    return dropped;
  }

  /** Send the warning for a change already decided. The address comes off the
   *  row, so nothing here can redirect it (KEHOACH 9.17 item 6 rule 3).
   */
  async mailNotice(changeId: string): Promise<boolean> {
    const change = await this.db.profileChange.findUnique({
      where: { id: changeId },
      include: { employee: { select: { fullName: true, locale: true } } },
    });
    const notice = change ? PROFILE_FIELDS[change.field].notice : null;
    if (!change?.noticeTo || notice === null) {
      this.log.warn(`change ${changeId} has nowhere to warn`);
      return false;
    }
    const sent = await this.mailer.send(
      change.noticeTo,
      profileNoticeMail(change.employee.locale, {
        fullName: change.employee.fullName,
        change: notice,
        decidedOn: (change.decidedAt ?? change.createdAt).toISOString().slice(0, 10),
      }),
    );
    if (sent) {
      await this.db.profileChange.update({
        where: { id: change.id },
        data: { noticeSentAt: new Date() },
      });
    }
    return sent;
  }

  private addressOf(person: Person): string | null {
    return person.personalEmail ?? person.login?.email ?? null;
  }

  private async reachable(viewer: Viewer, employeeId: number): Promise<Person> {
    const visible = await this.scope.deskOrSelfEmployeeIds(viewer);
    if (visible !== null && !visible.includes(employeeId)) {
      throw new NotFoundException("EMPLOYEE_NOT_FOUND");
    }
    const person = await this.db.employee.findUnique({
      where: { id: employeeId },
      include: { login: { select: { email: true } } },
    });
    if (!person) {
      throw new NotFoundException("EMPLOYEE_NOT_FOUND");
    }
    return person;
  }

  private async waiting(id: string): Promise<ProfileChange> {
    const held = await this.db.profileChange.findUnique({ where: { id } });
    if (!held) {
      throw new NotFoundException("PROFILE_CHANGE_NOT_FOUND");
    }
    if (held.state !== "PENDING") {
      throw new BadRequestException("PROFILE_CHANGE_DECIDED");
    }
    return held;
  }

  // Moves a change out of PENDING only if nobody else has; a second decider or a withdrawal loses.
  private async claim(
    tx: Prisma.TransactionClient,
    id: string,
    data: Prisma.ProfileChangeUncheckedUpdateManyInput,
  ): Promise<void> {
    const claimed = await tx.profileChange.updateMany({ where: { id, state: "PENDING" }, data });
    if (claimed.count !== 1) {
      throw new BadRequestException("PROFILE_CHANGE_DECIDED");
    }
  }

  private async decidable(viewer: Viewer, id: string): Promise<ProfileChange> {
    if (!DESK.includes(viewer.role)) {
      throw new ForbiddenException("HR_ONLY");
    }
    const held = await this.waiting(id);
    // Neither the person whose record it is nor the one who asked decides it (KEHOACH 9.17 item 6 rule 2).
    if (held.employeeId === viewer.employeeId || (held.askedById !== null && held.askedById === viewer.userId)) {
      throw new ForbiddenException("SELF_DECISION");
    }
    return held;
  }
}
