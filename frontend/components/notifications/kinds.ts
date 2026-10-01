import type { Icon as IconType } from "@phosphor-icons/react";
import {
  CalculatorIcon,
  CalendarDotsIcon,
  CalendarXIcon,
  ChatCircleTextIcon,
  CheckSquareIcon,
  ClockClockwiseIcon,
  CoinsIcon,
  DatabaseIcon,
  DeviceMobileIcon,
  FileTextIcon,
  HourglassMediumIcon,
  ListChecksIcon,
  LockSimpleIcon,
  PencilSimpleLineIcon,
  ReceiptIcon,
  ScanSmileyIcon,
  SignatureIcon,
  TimerIcon,
  TrayIcon,
  UsersThreeIcon,
} from "@phosphor-icons/react";

import type { RequestKind } from "@/components/requests/request-card";
import { todayIso } from "@/lib/format";

export type NoticeKind =
  | "REQUEST_DECIDED"
  | "REQUEST_WAITING"
  | "REQUEST_STALLED"
  | "PAYSLIP_ISSUED"
  | "CONTRACT_ENDING"
  | "DISPUTE_ANSWERED"
  | "ADVANCE_PAID"
  | "CONTRACT_DUE"
  | "PROBATION_DUE"
  | "PAYROLL_RUN_DONE"
  | "BACKUP_ALERT"
  | "KIOSK_ALERT"
  | "TASK_ASSIGNED"
  | "DOCUMENT_TO_SIGN"
  | "ATTENDANCE_EXCEPTION"
  | "TEAM_ATTENDANCE"
  | "DAY_CORRECTED"
  | "SHIFT_CHANGED"
  | "TIMESHEET_MONTH_CLOSED"
  | "PUNCH_RECORDED";

export type NoticeCategory = "REQUESTS" | "PAY" | "PEOPLE" | "ATTENDANCE" | "SYSTEM";

export const NOTICE_CATEGORIES: readonly NoticeCategory[] = ["REQUESTS", "PAY", "PEOPLE", "ATTENDANCE", "SYSTEM"];

export type NoticeOutcome = "APPROVED" | "REJECTED" | "ISSUED" | "UPHELD" | "PAID" | "RENEWED" | "RESOLVED" | "COMPLETED" | "SIGNED";

/** The shared state of a row of work, the same for every holder (KEHOACH 9.21.4). */
export interface NoticeItem {
  key: string;
  level: "INFO" | "ACTION" | "WARNING" | "CRITICAL";
  state: "OPEN" | "DONE" | "WITHDRAWN" | "EXPIRED" | "CLEARED";
  outcome: NoticeOutcome | null;
  actorId: string | null;
  actorName: string | null;
  openedAt: string;
  closedAt: string | null;
  claimedByName: string | null;
  dueAt: string | null;
}

/** Who and what a notice is about, built through the reader's scope when it is read; hidden names nothing. */
export interface NoticeSubject {
  type: string;
  id?: string | null;
  hidden: boolean;
  person: { id: number; code?: string; fullName?: string; department?: { id: string; name: string } | null } | null;
  request?: { kind: RequestKind; fromDate: string; toDate: string; days: string; leaveType: { code: string; name: string } | null } | null;
}

export interface Notice {
  id: string;
  kind: NoticeKind;
  requestId: string | null;
  advanceId: string | null;
  periodId: string | null;
  contractId: string | null;
  payslipId: string | null;
  certificateId?: string | null;
  profileChangeId?: string | null;
  dependentId?: string | null;
  daysLeft: number | null;
  daysWaited: number | null;
  approved: boolean | null;
  readAt: string | null;
  leftAt: string | null;
  archivedAt?: string | null;
  createdAt: string;
  remindedAt?: string | null;
  facts?: Readonly<Record<string, unknown>>;
  category?: NoticeCategory;
  item?: NoticeItem | null;
  subject?: NoticeSubject | null;
}

/** The catalogue keys under "notices" that name a notice. */
export type NoticeSentence =
  | "kindREQUEST_DECIDED_true"
  | "kindREQUEST_DECIDED_false"
  | "kindREQUEST_WAITING"
  | "kindREQUEST_WAITING_pay"
  | "kindREQUEST_STALLED"
  | "kindPAYSLIP_ISSUED"
  | "kindCONTRACT_ENDING"
  | "kindDISPUTE_ANSWERED"
  | "kindADVANCE_PAID"
  | "kindCONTRACT_DUE"
  | "kindPROBATION_DUE"
  | "kindPAYROLL_RUN_DONE"
  | "kindPAYROLL_RUN_DONE_count"
  | "kindPAYROLL_RUN_DONE_failed"
  | "kindBACKUP_ALERT"
  | "kindKIOSK_ALERT"
  | "kindKIOSK_ALERT_offline"
  | "kindKIOSK_ALERT_pending"
  | "kindKIOSK_ALERT_fault"
  | "kindKIOSK_ALERT_update"
  | "kindKIOSK_ALERT_spoof"
  | "kindKIOSK_ALERT_unknown"
  | "kindTASK_ASSIGNED"
  | "kindTASK_ASSIGNED_due"
  | "kindTASK_ASSIGNED_late"
  | "kindDOCUMENT_TO_SIGN"
  | "kindDOCUMENT_TO_SIGN_waiting"
  | "kindATTENDANCE_EXCEPTION"
  | "kindATTENDANCE_EXCEPTION_day"
  | "kindTEAM_ATTENDANCE"
  | "kindTEAM_ATTENDANCE_day"
  | "kindDAY_CORRECTED"
  | "kindDAY_CORRECTED_day"
  | "kindSHIFT_CHANGED"
  | "kindSHIFT_CHANGED_day"
  | "kindTIMESHEET_MONTH_CLOSED"
  | "kindTIMESHEET_MONTH_CLOSED_month"
  | "kindPUNCH_RECORDED";

/** A sentence key and what fills it: a count, or a day or a month as the facts carry them (YYYY-MM-DD, YYYY-MM). */
export interface Said {
  key: NoticeSentence;
  count?: number;
  day?: string;
  month?: string;
}

interface KindLook {
  icon: IconType;
  category: NoticeCategory;
  /** How Settings names the kind, with the count it shows there. */
  label: { key: NoticeSentence; count?: number };
  sentence: (notice: Notice) => Said;
  /** The page the notice opens, or null when no page says more than the notice (KEHOACH 9.21.4). */
  path: (notice: Notice) => string | null;
}

/** The queue and the item a waiting notice opens, read off the one reference it carries. */
function waitingAt(notice: Notice): string {
  if (notice.requestId) {
    return `/leave/${notice.requestId}`;
  }
  const [tab, id] = notice.certificateId
    ? ["certificates", notice.certificateId]
    : notice.profileChangeId
      ? ["profileChanges", notice.profileChangeId]
      : notice.dependentId
        ? ["dependents", notice.dependentId]
        : notice.advanceId
          ? [notice.approved ? "advancesToPay" : "advancesToDecide", notice.advanceId]
          : ["disputes", notice.subject?.type === "DISPUTE" && notice.subject.id ? notice.subject.id : (notice.payslipId ?? "")];
  return `/approvals?tab=${tab}&open=${id}`;
}

function decidedAt(notice: Notice): string {
  if (notice.certificateId) {
    return "/me/letters";
  }
  if (notice.profileChangeId || notice.dependentId) {
    return "/me/profile";
  }
  if (notice.advanceId) {
    return "/me/requests?tab=advances";
  }
  if (notice.payslipId) {
    return payslipAt(notice);
  }
  return notice.requestId ? `/me/requests?open=${notice.requestId}` : "/me/requests";
}

function payslipAt(notice: Notice): string {
  return notice.payslipId ? `/me/payslips?slip=${notice.payslipId}` : "/me/payslips";
}

// Every other code a kiosk's work carries is a hardware fault (KEHOACH 9.21.4).
const KIOSK_SENTENCE: Readonly<Record<string, NoticeSentence>> = {
  OFFLINE: "kindKIOSK_ALERT_offline",
  PENDING: "kindKIOSK_ALERT_pending",
  OTA_FAILED: "kindKIOSK_ALERT_update",
  OTA_ROLLED_BACK: "kindKIOSK_ALERT_update",
  SPOOF_BURST: "kindKIOSK_ALERT_spoof",
  UNKNOWN_BURST: "kindKIOSK_ALERT_unknown",
};

function kioskSentence(notice: Notice): NoticeSentence {
  const code = notice.facts?.code;
  return typeof code === "string" ? (KIOSK_SENTENCE[code] ?? "kindKIOSK_ALERT_fault") : "kindKIOSK_ALERT";
}

function personAt(notice: Notice, tab = ""): string | null {
  const person = notice.subject?.hidden ? null : notice.subject?.person;
  return person ? `/employees/${person.id}${tab}` : null;
}

function factText(notice: Notice, name: string): string | undefined {
  const value = notice.facts?.[name];
  return typeof value === "string" ? value : undefined;
}

/** The sentence that names the day the facts carry, or the one that names none. */
function onDay(notice: Notice, bare: NoticeSentence, dated: NoticeSentence): Said {
  const day = factText(notice, "day");
  return day ? { key: dated, day } : { key: bare };
}

function myDayAt(notice: Notice): string {
  const day = factText(notice, "day");
  return day ? `/me/attendance?day=${day}` : "/me/attendance";
}

// Today's summary opens the reader's home, which draws today; a day gone opens its exceptions in the timesheet.
function teamDayAt(notice: Notice): string {
  const day = factText(notice, "day");
  return !day || day === todayIso() ? "/" : `/timesheet?from=${day}&to=${day}&exceptions=1`;
}

const kContractDays = 30;
const kProbationDays = 7;
const kStalledDays = 7;

/** One row per kind, the frontend half of notice-kinds.ts; a kind missing here does not compile (KEHOACH 9.21.4). */
export const NOTICE_LOOK: Record<NoticeKind, KindLook> = {
  REQUEST_DECIDED: {
    icon: CheckSquareIcon,
    category: "REQUESTS",
    label: { key: "kindREQUEST_DECIDED_true" },
    sentence: (notice) => ({ key: notice.approved ? "kindREQUEST_DECIDED_true" : "kindREQUEST_DECIDED_false" }),
    path: decidedAt,
  },
  REQUEST_WAITING: {
    icon: TrayIcon,
    category: "REQUESTS",
    label: { key: "kindREQUEST_WAITING" },
    sentence: (notice) => ({
      key: notice.advanceId && notice.approved ? "kindREQUEST_WAITING_pay" : "kindREQUEST_WAITING",
    }),
    path: waitingAt,
  },
  REQUEST_STALLED: {
    icon: TimerIcon,
    category: "REQUESTS",
    label: { key: "kindREQUEST_STALLED", count: kStalledDays },
    sentence: (notice) => ({ key: "kindREQUEST_STALLED", count: notice.daysWaited ?? 0 }),
    path: decidedAt,
  },
  PAYSLIP_ISSUED: {
    icon: ReceiptIcon,
    category: "PAY",
    label: { key: "kindPAYSLIP_ISSUED" },
    sentence: () => ({ key: "kindPAYSLIP_ISSUED" }),
    path: payslipAt,
  },
  DISPUTE_ANSWERED: {
    icon: ChatCircleTextIcon,
    category: "PAY",
    label: { key: "kindDISPUTE_ANSWERED" },
    sentence: () => ({ key: "kindDISPUTE_ANSWERED" }),
    path: payslipAt,
  },
  ADVANCE_PAID: {
    icon: CoinsIcon,
    category: "PAY",
    label: { key: "kindADVANCE_PAID" },
    sentence: () => ({ key: "kindADVANCE_PAID" }),
    path: () => "/me/requests?tab=advances",
  },
  PAYROLL_RUN_DONE: {
    icon: CalculatorIcon,
    category: "PAY",
    label: { key: "kindPAYROLL_RUN_DONE" },
    sentence: (notice) =>
      notice.facts?.failed === true
        ? { key: "kindPAYROLL_RUN_DONE_failed" }
        : typeof notice.facts?.payslips === "number"
          ? { key: "kindPAYROLL_RUN_DONE_count", count: notice.facts.payslips }
          : { key: "kindPAYROLL_RUN_DONE" },
    path: (notice) => (notice.periodId ? `/payroll/${notice.periodId}` : "/payroll"),
  },
  CONTRACT_DUE: {
    icon: FileTextIcon,
    category: "PEOPLE",
    label: { key: "kindCONTRACT_DUE", count: kContractDays },
    sentence: (notice) => ({ key: "kindCONTRACT_DUE", count: notice.daysLeft ?? kContractDays }),
    path: (notice) => personAt(notice, "?tab=contracts"),
  },
  PROBATION_DUE: {
    icon: HourglassMediumIcon,
    category: "PEOPLE",
    label: { key: "kindPROBATION_DUE", count: kProbationDays },
    sentence: (notice) => ({ key: "kindPROBATION_DUE", count: notice.daysLeft ?? kProbationDays }),
    path: (notice) => personAt(notice),
  },
  BACKUP_ALERT: {
    icon: DatabaseIcon,
    category: "SYSTEM",
    label: { key: "kindBACKUP_ALERT" },
    sentence: () => ({ key: "kindBACKUP_ALERT" }),
    path: () => null,
  },
  KIOSK_ALERT: {
    icon: DeviceMobileIcon,
    category: "SYSTEM",
    label: { key: "kindKIOSK_ALERT" },
    sentence: (notice) => ({ key: kioskSentence(notice) }),
    path: (notice) => (notice.subject?.id && !notice.subject.hidden ? `/devices/${notice.subject.id}` : "/devices"),
  },
  TASK_ASSIGNED: {
    icon: ListChecksIcon,
    category: "PEOPLE",
    label: { key: "kindTASK_ASSIGNED" },
    sentence: (notice) => ({
      key: notice.daysLeft === null ? "kindTASK_ASSIGNED" : notice.daysLeft < 0 ? "kindTASK_ASSIGNED_late" : "kindTASK_ASSIGNED_due",
    }),
    path: (notice) => (notice.facts?.owner === "SELF" ? "/me" : personAt(notice, "?tab=checklist")),
  },
  DOCUMENT_TO_SIGN: {
    icon: SignatureIcon,
    category: "PEOPLE",
    label: { key: "kindDOCUMENT_TO_SIGN" },
    sentence: (notice) =>
      notice.daysWaited === null ? { key: "kindDOCUMENT_TO_SIGN" } : { key: "kindDOCUMENT_TO_SIGN_waiting", count: notice.daysWaited },
    path: (notice) => (notice.subject?.id ? `/me/documents?doc=${notice.subject.id}` : "/me/documents"),
  },
  CONTRACT_ENDING: {
    icon: CalendarDotsIcon,
    category: "PEOPLE",
    label: { key: "kindCONTRACT_ENDING", count: kContractDays },
    sentence: (notice) => ({ key: "kindCONTRACT_ENDING", count: notice.daysLeft ?? 0 }),
    path: () => null,
  },
  ATTENDANCE_EXCEPTION: {
    icon: CalendarXIcon,
    category: "ATTENDANCE",
    label: { key: "kindATTENDANCE_EXCEPTION" },
    sentence: (notice) => onDay(notice, "kindATTENDANCE_EXCEPTION", "kindATTENDANCE_EXCEPTION_day"),
    path: myDayAt,
  },
  TEAM_ATTENDANCE: {
    icon: UsersThreeIcon,
    category: "ATTENDANCE",
    label: { key: "kindTEAM_ATTENDANCE" },
    sentence: (notice) => onDay(notice, "kindTEAM_ATTENDANCE", "kindTEAM_ATTENDANCE_day"),
    path: teamDayAt,
  },
  DAY_CORRECTED: {
    icon: PencilSimpleLineIcon,
    category: "ATTENDANCE",
    label: { key: "kindDAY_CORRECTED" },
    sentence: (notice) => onDay(notice, "kindDAY_CORRECTED", "kindDAY_CORRECTED_day"),
    path: myDayAt,
  },
  SHIFT_CHANGED: {
    icon: ClockClockwiseIcon,
    category: "ATTENDANCE",
    label: { key: "kindSHIFT_CHANGED" },
    sentence: (notice) => onDay(notice, "kindSHIFT_CHANGED", "kindSHIFT_CHANGED_day"),
    path: () => "/me/shifts",
  },
  TIMESHEET_MONTH_CLOSED: {
    icon: LockSimpleIcon,
    category: "ATTENDANCE",
    label: { key: "kindTIMESHEET_MONTH_CLOSED" },
    sentence: (notice) => {
      const month = factText(notice, "month");
      return month ? { key: "kindTIMESHEET_MONTH_CLOSED_month", month } : { key: "kindTIMESHEET_MONTH_CLOSED" };
    },
    path: (notice) => {
      const month = factText(notice, "month");
      return month ? `/me/attendance?month=${month}` : "/me/attendance";
    },
  },
  PUNCH_RECORDED: {
    icon: ScanSmileyIcon,
    category: "ATTENDANCE",
    label: { key: "kindPUNCH_RECORDED" },
    sentence: () => ({ key: "kindPUNCH_RECORDED" }),
    path: () => null,
  },
};
