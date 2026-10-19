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

import { EXPORT_MAX_ROWS, toExcelCsv } from "../../common/csv.js";
import { COUNT_CEILING, countedTo, nextCursor, resumeAfter } from "../../common/dto/cursor.dto.js";
import type { Page } from "../../common/dto/pagination.dto.js";
import { ScopeService } from "../../common/scope/scope.service.js";
import { refuseOwn, type Viewer } from "../../common/scope/viewer.js";
import type { Env } from "../../config/env.schema.js";
import { isPrismaCode, PrismaService, UNIQUE_VIOLATION } from "../../database/prisma.service.js";
import { QUEUE_TOKEN, type Queues } from "../../queue/queue.module.js";
import { JOB, QUEUE, type ProfileNoticeJob } from "../../queue/queues.js";
import { AUDIT_ACTIONS, AUDIT_SUBJECTS } from "../audit/audit-actions.js";
import { AuditService } from "../audit/audit.service.js";
import type { Order } from "../leave/dto/queue.dto.js";
import {
  PERSON_VIEW,
  QUEUE_DESKS,
  filedBetween,
  personWhere,
  sortedBy,
  waitedDays,
} from "../leave/queue-filter.js";
import { MailerService } from "../notifications/mailer.service.js";
import { NotificationsService } from "../notifications/notifications.service.js";
import { AudienceService } from "../notifications/audience.service.js";
import { NoticeItemsService } from "../notifications/notice-items.service.js";
import { NAMED, nameOf } from "../notifications/notifications.service.js";
import { profileNoticeMail } from "../payroll/mail-text.js";
import { localDay } from "../timesheet/local-day.js";
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
const EXPORT_COLUMNS = [
  "code", "fullName", "department", "field", "oldValue", "newValue", "reason",
  "createdAt", "state", "decidedBy", "decidedAt", "note",
];

type Person = Employee & { login: { email: string } | null };

type Listed = Prisma.ProfileChangeGetPayload<{ include: { employee: typeof PERSON_VIEW } }>;

export interface ProfileChangeRow extends Listed {
  waitedDays: number;
  decidedByName: string | null;
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
    private readonly audience: AudienceService,
    private readonly items: NoticeItemsService,
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
    if (want.personalEmail) {
      await this.refuseTakenAddress(employeeId, want.personalEmail);
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
    await this.items.open("PROFILE_CHANGES", made);
    return made;
  }

  async list(viewer: Viewer, query: ListProfileChangesDto): Promise<Page<ProfileChangeRow>> {
    const { where, order } = await this.selected(viewer, query);
    const resumed = query.cursor
      ? { AND: [where, resumeAfter("createdAt", order, query.cursor) as Prisma.ProfileChangeWhereInput] }
      : where;
    const [rows, found] = await Promise.all([
      this.db.profileChange.findMany({
        where: resumed,
        skip: query.cursor ? 0 : query.skip,
        take: query.take,
        orderBy: sortedBy("createdAt", order) as Prisma.ProfileChangeOrderByWithRelationInput[],
        include: { employee: PERSON_VIEW, decidedBy: NAMED },
      }),
      this.db.profileChange.count({ where, take: COUNT_CEILING + 1 }),
    ]);
    const now = new Date();
    return {
      rows: rows.map(({ decidedBy, ...row }) => ({ ...row, waitedDays: waitedDays(row.createdAt, now), decidedByName: nameOf(decidedBy) })),
      ...countedTo(found),
      next: nextCursor(rows, query.take, (row) => row.createdAt),
    };
  }

  /** The list under the same filter, as a file Excel opens (KEHOACH 9.15). */
  async exportCsv(viewer: Viewer, query: ListProfileChangesDto): Promise<string> {
    const { where, order } = await this.selected(viewer, query);
    const rows = await this.db.profileChange.findMany({
      where,
      orderBy: sortedBy("createdAt", order) as Prisma.ProfileChangeOrderByWithRelationInput[],
      take: EXPORT_MAX_ROWS,
      include: { employee: PERSON_VIEW, decidedBy: NAMED },
    });
    await this.audit.record({
      actorId: viewer.userId,
      action: AUDIT_ACTIONS.EXPORT_PROFILE_CHANGES,
      subject: AUDIT_SUBJECTS.EXPORT,
      subjectId: "profile-changes",
      meta: { filters: { ...query }, rows: rows.length },
    });
    // The parts of a field in the order the register reads them, as one cell.
    const valuesOf = (row: ProfileChange, values: Prisma.JsonValue | null) =>
      PROFILE_FIELDS[row.field].columns
        .map((column) => ((values ?? {}) as ProfileValues)[column] ?? "")
        .filter((one) => one !== "")
        .join(" · ");
    return toExcelCsv(
      EXPORT_COLUMNS,
      rows.map((row) => [
        row.employee.code,
        row.employee.fullName,
        row.employee.department?.name ?? "",
        row.field,
        valuesOf(row, row.oldValue),
        valuesOf(row, row.newValue),
        row.reason ?? "",
        row.createdAt.toISOString(),
        row.state,
        nameOf(row.decidedBy) ?? "",
        row.decidedAt?.toISOString() ?? "",
        row.note ?? "",
      ]),
    );
  }

  private async selected(
    viewer: Viewer,
    query: ListProfileChangesDto,
  ): Promise<{ where: Prisma.ProfileChangeWhereInput; order: Order }> {
    const visible = await this.scope.deskOrSelfEmployeeIds(viewer);
    const person = await personWhere(this.db, query);
    const waiting = query.state === "PENDING";
    // Every clause names employeeId, so an AND keeps the narrowest rather than letting one replace another.
    const where = {
      AND: [
        ScopeService.ownedWhere(viewer, visible),
        query.employeeId === undefined ? {} : { employeeId: query.employeeId },
        await this.audience.inboxNarrowing(viewer, "PROFILE_CHANGES", waiting, query.employeeId),
        query.state ? { state: query.state } : {},
        query.field ? { field: query.field } : {},
        person ? { employee: person } : {},
        filedBetween("createdAt", query, this.config.get("APP_TIMEZONE", { infer: true })),
      ],
    } as Prisma.ProfileChangeWhereInput;
    return { where, order: query.order ?? (waiting ? "asc" : "desc") };
  }

  /** One record through the list's own scope, so the inbox opens it wherever it sits in the queue (KEHOACH 9.21.4). */
  async one(viewer: Viewer, id: string): Promise<ProfileChangeRow> {
    const visible = await this.scope.deskOrSelfEmployeeIds(viewer);
    const held = await this.db.profileChange.findUnique({ where: { id }, include: { employee: PERSON_VIEW, decidedBy: NAMED } });
    if (!held || !(await this.scope.reaches(viewer, visible, held.employeeId))) {
      throw new NotFoundException("PROFILE_CHANGE_NOT_FOUND");
    }
    const { decidedBy, ...row } = held;
    return { ...row, waitedDays: waitedDays(row.createdAt, new Date()), decidedByName: nameOf(decidedBy) };
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
    const { given, movedLogin } = await this.db
      .$transaction(async (tx) => {
        await this.claim(tx, held.id, { state: "APPROVED", decidedAt: new Date(), decidedById: viewer.userId });
        await tx.employee.update({ where: { id: held.employeeId }, data: write });
        const moved = write.personalEmail ? await moveSignIn(tx, held.employeeId, write.personalEmail) : null;
        return { given: await tx.profileChange.findUniqueOrThrow({ where: { id: held.id } }), movedLogin: moved };
      })
      .catch((error: unknown) => {
        throw isPrismaCode(error, UNIQUE_VIOLATION) ? new ConflictException("EMAIL_TAKEN") : error;
      });
    await this.audit.record({
      actorId: viewer.userId,
      action: AUDIT_ACTIONS.PROFILE_APPROVE,
      subject: AUDIT_SUBJECTS.EMPLOYEE,
      subjectId: String(held.employeeId),
      meta: { field: held.field, noticeTo: held.noticeTo },
    });
    if (movedLogin) {
      await this.audit.record({
        actorId: viewer.userId,
        action: AUDIT_ACTIONS.USER_EMAIL,
        subject: AUDIT_SUBJECTS.USER,
        subjectId: movedLogin,
        meta: { profileChangeId: held.id },
      });
    }
    if (PROFILE_FIELDS[held.field].notice !== null && held.noticeTo !== null) {
      await this.queues[QUEUE.notify].add(JOB.profileNotice, {
        type: JOB.profileNotice,
        changeId: held.id,
      } satisfies ProfileNoticeJob);
    }
    this.log.log(`profile ${held.field} changed for employee ${held.employeeId}`);
    await this.items.close("PROFILE_CHANGES", held.id, { state: "DONE", outcome: "APPROVED", actorId: viewer.userId });
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
    await this.items.close("PROFILE_CHANGES", held.id, { state: "DONE", outcome: "REJECTED", actorId: viewer.userId });
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
    await this.items.close("PROFILE_CHANGES", held.id, { state: "WITHDRAWN", actorId: viewer.userId });
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
        decidedOn: localDay(change.decidedAt ?? change.createdAt, this.config.get("APP_TIMEZONE", { infer: true })),
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

  /** A contact email becomes the sign-in address too, so another account's address is refused when asked for (KEHOACH 9.4). */
  private async refuseTakenAddress(employeeId: number, address: string): Promise<void> {
    const taken = await this.db.user.findFirst({
      where: {
        email: { equals: address, mode: "insensitive" },
        OR: [{ employeeId: null }, { employeeId: { not: employeeId } }],
      },
      select: { id: true },
    });
    if (taken) {
      throw new ConflictException("EMAIL_TAKEN");
    }
  }

  private async reachable(viewer: Viewer, employeeId: number): Promise<Person> {
    if (!(await this.reaches(viewer, employeeId))) {
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

  /** A change still pending; one named for a decider must also be about somebody that decider reaches. */
  private async waiting(id: string, decider?: Viewer): Promise<ProfileChange> {
    const held = await this.db.profileChange.findUnique({ where: { id } });
    if (!held || (decider !== undefined && !(await this.reaches(decider, held.employeeId)))) {
      throw new NotFoundException("PROFILE_CHANGE_NOT_FOUND");
    }
    if (held.state !== "PENDING") {
      throw new ConflictException("PROFILE_CHANGE_DECIDED");
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
      throw new ConflictException("PROFILE_CHANGE_DECIDED");
    }
  }

  private async decidable(viewer: Viewer, id: string): Promise<ProfileChange> {
    if (!DESK.includes(viewer.role)) {
      throw new ForbiddenException("HR_ONLY");
    }
    const held = await this.waiting(id, viewer);
    // Neither the person whose record it is nor the one who asked decides it (KEHOACH 9.17 item 6 rule 2).
    if (held.askedById !== null && held.askedById === viewer.userId) {
      throw new ForbiddenException("SELF_DECISION");
    }
    refuseOwn(viewer, held.employeeId);
    return held;
  }

  private async reaches(viewer: Viewer, employeeId: number): Promise<boolean> {
    return this.scope.reaches(viewer, await this.scope.deskOrSelfEmployeeIds(viewer), employeeId);
  }
}

/** Move the person's sign-in address to the contact email just approved; the account it moved, if one did (KEHOACH 9.4).
 *  @ctx inside the approval's transaction | throws a unique violation when another account holds the address
 */
async function moveSignIn(tx: Prisma.TransactionClient, employeeId: number, address: string): Promise<string | null> {
  const login = await tx.user.findUnique({ where: { employeeId }, select: { id: true, email: true } });
  if (!login || login.email === address) {
    return null;
  }
  await tx.user.update({ where: { id: login.id }, data: { email: address } });
  return login.id;
}
