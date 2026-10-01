import { Injectable } from "@nestjs/common";
import type { NoticeSubject, Prisma, RequestKind } from "@prisma/client";

import { ScopeService } from "../../common/scope/scope.service.js";
import type { Viewer } from "../../common/scope/viewer.js";
import { PrismaService } from "../../database/prisma.service.js";
import { PERSON_VIEW } from "../leave/queue-filter.js";

// HR data reads by the tree; pay and papers only by the desk or their owner (KEHOACH 9.4).
const BY_TREE: ReadonlySet<NoticeSubject> = new Set<NoticeSubject>(["REQUEST", "CONTRACT", "PERSON_DAY"]);

export interface SubjectPerson {
  id: number;
  code: string;
  fullName: string;
  department: { id: string; name: string } | null;
}

/** The record a notice opens when its subject sits inside another: a dispute's payslip, a payroll run's period. */
export interface SubjectParent {
  type: NoticeSubject;
  id: string;
}

export interface SubjectRequest {
  kind: RequestKind;
  fromDate: Date;
  toDate: Date;
  days: string;
  leaveType: { code: string; name: string } | null;
}

/** What a notice is about, as this viewer may see it now; hidden carries neither a name nor a way in. */
export interface SubjectView {
  type: NoticeSubject;
  id: string | null;
  hidden: boolean;
  person: SubjectPerson | null;
  request: SubjectRequest | null;
  parent: SubjectParent | null;
}

interface Subjected {
  subjectType: NoticeSubject | null;
  subjectId: string | null;
  subjectEmployeeId: number | null;
}

/** People and days behind notices, built at read time through the reader's scope (KEHOACH 9.21.4). */
@Injectable()
export class SubjectsService {
  constructor(
    private readonly db: PrismaService,
    private readonly scope: ScopeService,
  ) {}

  /** The employees whose notices a person search may match, per kind of subject; null reaches everybody.
   *  @ctx any | reads the viewer's scope
   */
  async reach(viewer: Viewer): Promise<{ byTree: number[] | null; byDesk: number[] | null }> {
    const [byTree, byDesk] = await Promise.all([
      this.scope.visibleEmployeeIds(viewer),
      this.scope.deskOrSelfEmployeeIds(viewer),
    ]);
    return { byTree, byDesk };
  }

  /** The where clause that keeps a person search to subjects this viewer may still see. */
  searchable(reach: { byTree: number[] | null; byDesk: number[] | null }, person: Prisma.EmployeeWhereInput): Prisma.NotificationWhereInput {
    const within = (ids: number[] | null): Prisma.EmployeeWhereInput => (ids === null ? person : { AND: [person, { id: { in: ids } }] });
    return {
      OR: [
        { subjectType: { in: [...BY_TREE] }, subjectEmployee: { is: within(reach.byTree) } },
        { subjectType: { notIn: [...BY_TREE] }, subjectEmployee: { is: within(reach.byDesk) } },
      ],
    };
  }

  /** Each row's subject, in the order given; a row with no subject reads null.
   *  @ctx any | at most five reads whatever the number of rows
   */
  async describe(viewer: Viewer, rows: Subjected[]): Promise<(SubjectView | null)[]> {
    const reach = await this.reach(viewer);
    const sees = (row: Subjected): boolean => {
      const ids = row.subjectType !== null && BY_TREE.has(row.subjectType) ? reach.byTree : reach.byDesk;
      return row.subjectEmployeeId === null || ids === null || ids.includes(row.subjectEmployeeId);
    };
    const shown = rows.filter((row) => row.subjectType !== null && sees(row));
    const people = [...new Set(shown.flatMap((row) => (row.subjectEmployeeId === null ? [] : [row.subjectEmployeeId])))];
    const of = (type: NoticeSubject) => shown.flatMap((row) => (row.subjectType === type && row.subjectId ? [row.subjectId] : []));
    const requests = of("REQUEST");
    const disputes = of("DISPUTE");
    const runs = of("PAYROLL_RUN");
    const [persons, filed, slips, periods] = await Promise.all([
      people.length === 0 ? [] : this.db.employee.findMany({ where: { id: { in: people } }, select: PERSON_VIEW.select }),
      requests.length === 0
        ? []
        : this.db.request.findMany({
            where: { id: { in: requests } },
            select: { id: true, kind: true, fromDate: true, toDate: true, days: true, leaveType: { select: { code: true, name: true } } },
          }),
      disputes.length === 0 ? [] : this.db.payslipDispute.findMany({ where: { id: { in: disputes } }, select: { id: true, payslipId: true } }),
      runs.length === 0 ? [] : this.db.payrollRun.findMany({ where: { id: { in: runs } }, select: { id: true, periodId: true } }),
    ]);
    const personOf = new Map(persons.map((one) => [one.id, one]));
    const requestOf = new Map(filed.map((one) => [one.id, one]));
    const parentOf = new Map<string, SubjectParent>([
      ...slips.map((one): [string, SubjectParent] => [`DISPUTE:${one.id}`, { type: "PAYSLIP", id: one.payslipId }]),
      ...periods.map((one): [string, SubjectParent] => [`PAYROLL_RUN:${one.id}`, { type: "PAYROLL_PERIOD", id: one.periodId }]),
    ]);
    return rows.map((row) => {
      if (row.subjectType === null) {
        return null;
      }
      if (!sees(row)) {
        return { type: row.subjectType, id: null, hidden: true, person: null, request: null, parent: null };
      }
      const asked = row.subjectId ? requestOf.get(row.subjectId) : undefined;
      return {
        type: row.subjectType,
        id: row.subjectId,
        hidden: false,
        person: row.subjectEmployeeId === null ? null : (personOf.get(row.subjectEmployeeId) ?? null),
        request: asked
          ? { kind: asked.kind, fromDate: asked.fromDate, toDate: asked.toDate, days: asked.days.toString(), leaveType: asked.leaveType }
          : null,
        parent: parentOf.get(`${row.subjectType}:${row.subjectId}`) ?? null,
      };
    });
  }
}
