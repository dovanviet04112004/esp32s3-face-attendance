"use client";

import { Button, Input, LayerCard } from "@cloudflare/kumo";
import type { Icon as IconType } from "@phosphor-icons/react";
import {
  CaretRightIcon,
  CertificateIcon,
  CheckCircleIcon,
  CheckIcon,
  CoinsIcon,
  FileTextIcon,
  HandCoinsIcon,
  ReceiptIcon,
  UserListIcon,
  UsersThreeIcon,
  XIcon,
} from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { useState, type AnimationEvent, type FormEvent } from "react";

import { COUNTS_KEY, QUEUE_ROLES, WAITING_POLL_MS, useInboxCounts, type Queue } from "@/components/nav/waiting-count";
import { Failed } from "@/components/ui/failed";
import { useNotify } from "@/components/ui/notify";
import { CountPill, StatePill } from "@/components/ui/pill";
import { SkeletonLine } from "@/components/ui/skeleton";
import { Link } from "@/i18n/navigation";
import { api } from "@/lib/api";
import { useSession } from "@/lib/auth";
import { cn } from "@/lib/cn";
import { dayOnly, days } from "@/lib/format";
import { allows } from "@/lib/nav";
import { useRequestWords, type InboxRow } from "./request-card";

const kPreviewRows = 5;
const kReasonMax = 500;

const QUEUE_ORDER: Queue[] = [
  "requests",
  "disputes",
  "certificates",
  "profileChanges",
  "dependents",
  "advancesToDecide",
  "advancesToPay",
];

const QUEUE_ICON: Record<Queue, IconType> = {
  requests: FileTextIcon,
  disputes: ReceiptIcon,
  certificates: CertificateIcon,
  profileChanges: UserListIcon,
  dependents: UsersThreeIcon,
  advancesToDecide: HandCoinsIcon,
  advancesToPay: CoinsIcon,
};

const QUEUE_LABEL = {
  requests: "queueRequests",
  disputes: "queueDisputes",
  certificates: "queueCertificates",
  profileChanges: "queueProfile",
  dependents: "queueDependents",
  advancesToDecide: "queueAdvances",
  advancesToPay: "queueToPay",
} as const satisfies Record<Queue, string>;

interface Decision {
  row: InboxRow;
  approve: boolean;
  note?: string;
}

// Kumo draws each line at a random width and pace, which the server render cannot match.

/** A request's dates without the year when it is this year's, so a row stays on one line. */
export function useShortSpan(): (row: Pick<InboxRow, "fromDate" | "toDate">) => string {
  const format = useFormatter();
  const year = new Date().getFullYear();
  const one = (iso: string) => {
    const at = dayOnly(iso);
    return format.dateTime(at, at.getFullYear() === year ? { day: "numeric", month: "numeric" } : { dateStyle: "short" });
  };
  return (row) =>
    row.fromDate.slice(0, 10) === row.toDate.slice(0, 10) ? one(row.fromDate) : `${one(row.fromDate)} – ${one(row.toDate)}`;
}

function Waiting() {
  return (
    <ul aria-hidden className="flex flex-col">
      {Array.from({ length: 3 }, (_, at) => (
        <li key={at} className="flex flex-col gap-2 border-b border-kumo-hairline px-4 py-3.5 last:border-0">
          <SkeletonLine minWidth={37} maxWidth={37} />
          <SkeletonLine minWidth={55} maxWidth={55} />
        </li>
      ))}
    </ul>
  );
}

function QueueLine({ queue, value, label }: { queue: Queue; value: number; label: string }) {
  const format = useFormatter();
  const Icon = QUEUE_ICON[queue];
  return (
    <li className="border-b border-kumo-hairline last:border-0">
      <Link href={`/approvals?tab=${queue}`} className="flex min-h-12 items-center gap-3 px-4 py-2 hover:bg-kumo-tint motion-press">
        <Icon size={18} className="shrink-0 text-kumo-subtle" aria-hidden />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <span className="shrink-0 font-medium tabular-nums">{format.number(value)}</span>
        <CaretRightIcon size={14} className="shrink-0 text-kumo-subtle" aria-hidden />
      </Link>
    </li>
  );
}

/** The oldest requests waiting on this viewer, decided in place, and a line per other queue (KEHOACH 9.10). */
export function InboxPreview() {
  const t = useTranslations("home");
  const r = useTranslations("requests");
  const common = useTranslations("common");
  const format = useFormatter();
  const locale = useLocale();
  const words = useRequestWords();
  const shortSpan = useShortSpan();
  const notify = useNotify();
  const cache = useQueryClient();
  const { role, employeeId } = useSession();
  const counts = useInboxCounts(role);
  const [refusing, setRefusing] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [decided, setDecided] = useState<string[]>([]);

  const inbox = useQuery({
    queryKey: ["requests", "inbox", "preview"],
    refetchInterval: WAITING_POLL_MS,
    queryFn: async () =>
      (await api.get<{ rows: InboxRow[]; total: number }>(`/requests/inbox?take=${kPreviewRows}&order=asc`)).data,
  });

  const decide = useMutation({
    mutationFn: (what: Decision) =>
      api.post(`/requests/${what.row.id}/decide`, { approve: what.approve, note: what.note || undefined }),
    onSuccess: (_, what) => {
      const name = what.row.employee?.fullName ?? "none";
      notify.done(what.approve ? r("approvedOf", { name }) : r("rejectedOf", { name }));
      setRefusing(null);
      setDecided((held) => [...held, what.row.id]);
    },
    onError: (fell: unknown) => {
      notify.failed(fell);
      void cache.invalidateQueries({ queryKey: ["requests", "inbox"] });
    },
  });

  const rows = inbox.data?.rows ?? [];
  const mine = QUEUE_ORDER.filter((one) => role !== null && QUEUE_ROLES[one].includes(role));
  const count = (queue: Queue) => (queue === "requests" ? (counts.data?.requests ?? inbox.data?.total ?? 0) : (counts.data?.[queue] ?? 0));
  const total = mine.reduce((sum, one) => sum + count(one), 0);
  const unseenRequests = count("requests") - rows.length;
  const others = mine.filter((one) => one !== "requests" && count(one) > 0);
  const opensRecord = allows(role, employeeId !== null, "/leave/record");
  const pending = inbox.isPending || (counts.isPending && counts.fetchStatus !== "idle");

  // The row fades and closes first, then the list refetches, so nothing under it jumps.
  function closed(event: AnimationEvent<HTMLLIElement>): void {
    if (event.target === event.currentTarget) {
      void cache.invalidateQueries({ queryKey: ["requests"] });
      void cache.invalidateQueries({ queryKey: ["leave-balances"] });
      void cache.invalidateQueries({ queryKey: COUNTS_KEY });
    }
  }

  function refuse(event: FormEvent, row: InboxRow): void {
    event.preventDefault();
    decide.mutate({ row, approve: false, note: reason.trim() });
  }

  return (
    <LayerCard>
      <LayerCard.Secondary className="justify-between gap-3">
        <span className="flex items-center gap-2">
          {r("approvalsTitle")}
          {total > 0 ? <CountPill>{format.number(total)}</CountPill> : null}
        </span>
        {total > 0 ? (
          <Link href="/approvals" className="font-normal text-kumo-link hover:underline">
            {t("seeAll", { count: total })}
          </Link>
        ) : null}
      </LayerCard.Secondary>
      <LayerCard.Primary className="gap-0 p-0 pr-0">
        {inbox.isError ? (
          <div className="p-4">
            <Failed onRetry={() => void inbox.refetch()} />
          </div>
        ) : pending ? (
          <Waiting />
        ) : total === 0 ? (
          <p className="flex items-center gap-2.5 px-4 py-3.5 text-kumo-subtle">
            <CheckCircleIcon size={18} weight="fill" className="shrink-0 text-kumo-success" aria-hidden />
            {r("nothingWaiting")}
          </p>
        ) : (
          <ul className="flex flex-col">
            {rows.map((row) => {
              const who = row.employee;
              const what = [row.leaveType?.name, shortSpan(row), words.extent(row)].filter(Boolean);
              const context = [
                row.balanceAfter === null ? null : t("balanceAfter", { days: days(row.balanceAfter, locale) }),
                row.overlapCount === null ? null : t("overlap", { count: row.overlapCount }),
              ].filter(Boolean);
              const busy = decide.isPending && decide.variables?.row.id === row.id;
              return (
                <li
                  key={row.id}
                  onAnimationEnd={closed}
                  className={cn(
                    "flex flex-col gap-3 border-b border-kumo-hairline px-4 py-3 last:border-0",
                    decided.includes(row.id) && "motion-collapse",
                  )}
                >
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <Link href={opensRecord ? `/leave/${row.id}` : "/approvals"} className="group flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="flex min-w-0 items-baseline gap-2">
                        <span className="truncate font-medium group-hover:underline">{who?.fullName ?? common("empty")}</span>
                        <span className="shrink-0 font-mono text-sm text-kumo-subtle">{who?.code}</span>
                        {who?.department ? (
                          <span className="hidden truncate text-sm text-kumo-subtle md:inline">{who.department.name}</span>
                        ) : null}
                      </span>
                      <span className="tabular-nums">
                        <span className="text-kumo-default">{r(`kind${row.kind}`)}</span>
                        <span className="text-kumo-subtle"> · {what.join(" · ")}</span>
                      </span>
                      {context.length > 0 ? (
                        <span className="text-sm text-kumo-subtle tabular-nums">{context.join(" · ")}</span>
                      ) : null}
                    </Link>
                    <div className="flex shrink-0 items-center gap-2">
                      <StatePill tone="waiting" className="me-auto tabular-nums sm:me-1">
                        {row.waitedDays > 0 ? r("waited", { count: row.waitedDays }) : r("statePENDING")}
                      </StatePill>
                      <Button
                        size="sm"
                        variant="secondary"
                        icon={CheckIcon}
                        loading={busy && decide.variables?.approve}
                        disabled={busy}
                        onClick={() => decide.mutate({ row, approve: true })}
                      >
                        {r("approve")}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={XIcon}
                        disabled={busy}
                        aria-expanded={refusing === row.id}
                        onClick={() => {
                          setReason("");
                          setRefusing(refusing === row.id ? null : row.id);
                        }}
                      >
                        {r("reject")}
                      </Button>
                    </div>
                  </div>
                  {refusing === row.id ? (
                    <form onSubmit={(event) => refuse(event, row)} className="flex flex-col gap-2 motion-enter sm:flex-row sm:items-end">
                      <div className="min-w-0 flex-1">
                        <Input
                          label={r("rejectReason")}
                          required
                          maxLength={kReasonMax}
                          autoFocus
                          value={reason}
                          onChange={(event) => setReason(event.target.value)}
                        />
                      </div>
                      <div className="flex gap-2">
                        <Button type="submit" variant="destructive" loading={busy} disabled={reason.trim() === ""}>
                          {r("rejectSend")}
                        </Button>
                        <Button variant="ghost" onClick={() => setRefusing(null)}>
                          {common("cancel")}
                        </Button>
                      </div>
                    </form>
                  ) : null}
                </li>
              );
            })}
            {rows.length > 0 && unseenRequests > 0 ? (
              <QueueLine queue="requests" value={unseenRequests} label={t("moreRequests")} />
            ) : null}
            {rows.length === 0 && count("requests") > 0 ? (
              <QueueLine queue="requests" value={count("requests")} label={r(QUEUE_LABEL.requests)} />
            ) : null}
            {others.map((queue) => (
              <QueueLine key={queue} queue={queue} value={count(queue)} label={r(QUEUE_LABEL[queue])} />
            ))}
          </ul>
        )}
      </LayerCard.Primary>
    </LayerCard>
  );
}
