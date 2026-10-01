import type { Icon as IconType } from "@phosphor-icons/react";
import {
  CalendarDotsIcon,
  ChatCircleTextIcon,
  CheckSquareIcon,
  CoinsIcon,
  ReceiptIcon,
  TimerIcon,
  TrayIcon,
} from "@phosphor-icons/react";

export type NoticeKind =
  | "REQUEST_DECIDED"
  | "REQUEST_WAITING"
  | "REQUEST_STALLED"
  | "PAYSLIP_ISSUED"
  | "CONTRACT_ENDING"
  | "DISPUTE_ANSWERED"
  | "ADVANCE_PAID";

export type NoticeCategory = "REQUESTS" | "PAY" | "PEOPLE" | "ATTENDANCE" | "SYSTEM";

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
  createdAt: string;
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
  | "kindADVANCE_PAID";

interface KindLook {
  icon: IconType;
  category: NoticeCategory;
  /** How Settings names the kind, with the count it shows there. */
  label: { key: NoticeSentence; count?: number };
  sentence: (notice: Notice) => { key: NoticeSentence; count?: number };
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
          : ["disputes", notice.payslipId ?? ""];
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
  return notice.requestId ? `/me/requests?open=${notice.requestId}` : "/me/requests";
}

function payslipAt(notice: Notice): string {
  return notice.payslipId ? `/me/payslips?slip=${notice.payslipId}` : "/me/payslips";
}

const kContractDays = 30;
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
  CONTRACT_ENDING: {
    icon: CalendarDotsIcon,
    category: "PEOPLE",
    label: { key: "kindCONTRACT_ENDING", count: kContractDays },
    sentence: (notice) => ({ key: "kindCONTRACT_ENDING", count: notice.daysLeft ?? 0 }),
    path: () => null,
  },
};
