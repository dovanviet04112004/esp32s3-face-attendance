"use client";

import { Button, LayerCard, LayerDialog, Tabs } from "@cloudflare/kumo";
import { CaretRightIcon, CheckCircleIcon, CheckIcon } from "@phosphor-icons/react";
import { useInfiniteQuery, useQuery, type UseQueryResult } from "@tanstack/react-query";
import { isAxiosError } from "axios";
import { useFormatter, useLocale, useNow, useTranslations } from "next-intl";
import { useState, type ReactNode } from "react";

import { REQUEST_DECIDERS } from "@/components/nav/waiting-count";
import { type Person } from "@/components/requests/request-card";
import { InboxPreview } from "@/components/requests/inbox-preview";
import { Failed } from "@/components/ui/failed";
import { PageHeader, PageLayout } from "@/components/ui/page";
import { StatePill, type Tone } from "@/components/ui/pill";
import { SkeletonLine } from "@/components/ui/skeleton";
import { Link } from "@/i18n/navigation";
import { api } from "@/lib/api";
import { useSession, type Role } from "@/lib/auth";
import { cn } from "@/lib/cn";
import { dayOnly, percent, todayIso } from "@/lib/format";
import { allows } from "@/lib/nav";

interface Today {
  date: string;
  expected: number;
  present: number;
  late: number;
  absentUnexcused: number;
  onLeave: number;
}

interface PersonRef {
  id: number;
  code: string;
  fullName: string;
}

interface TeamToday {
  absent: PersonRef[];
  onLeave: PersonRef[];
  notPunched: PersonRef[];
  totals: { absent: number; onLeave: number; notPunched: number };
}

type TeamBucket = keyof TeamToday["totals"];

interface PersonPage {
  rows: PersonRef[];
  total: number;
  next: string | null;
}

const kBucketPage = 50;

interface ExceptionPage {
  rows: Exception[];
  total: number;
  next: string | null;
}

interface Heap<T> {
  rows: T[];
  total: number;
  totalIsExact: boolean;
}

type ExceptionReason = "NO_PUNCH" | "LATE" | "STILL_IN" | "QUESTIONABLE_TIME";
type ContractKind = "PROBATION" | "FIXED_TERM" | "INDEFINITE" | "SEASONAL" | "INTERNSHIP";

interface Expiring {
  contractId: string;
  employeeId: number;
  code: string;
  fullName: string;
  kind: ContractKind;
  endsOn: string;
  daysLeft: number;
}

interface Exception {
  employeeId: number;
  code: string;
  fullName: string;
  reason: ExceptionReason;
  minutes: number;
  receivedAt?: string | null;
}

interface Attention {
  contractsEnding: Heap<Expiring>;
  probationEnding: Heap<Expiring>;
  exceptionsToday: Heap<Exception>;
}

interface OverdueTask {
  id: string;
  title: string;
  dueOn: string;
  run: { employee: Person };
}

interface Period {
  id: string;
  year: number;
  month: number;
  state: "OPEN" | "LOCKED" | "PAID";
}

interface Run {
  kind: string;
  state: string;
}

type BlockerCode =
  | "REQUESTS_PENDING"
  | "CORRECTIONS_OPEN"
  | "NO_COMPENSATION"
  | "NO_ATTENDANCE_DAYS"
  | "LEAVERS_HOLDING_ASSETS"
  | "DISPUTES_OVERDUE"
  | "NO_LEGAL_ENTITY";

interface Blocker {
  code: BlockerCode;
  count: number;
}

interface DeviceCounts {
  PENDING: number;
  APPROVED: number;
  online: number;
  offline: number;
}

interface FleetUpdate {
  behind: string[];
  updating: string[];
}

interface PileRow {
  key: string;
  href: string;
  name: string;
  code: string;
  detail?: string;
  aside: ReactNode;
}

interface Pile {
  label: string;
  total: number;
  exact: boolean;
  rows: PileRow[];
  /** Where the whole pile is handled; a pile with no such page lists its rows only. */
  full?: string;
  /** Or a sheet that lists the whole pile, when no page holds it. */
  onAll?: () => void;
  /** What goes wrong when the pile is left alone, said once under it. */
  hint?: string;
}

type HrTab = "contracts" | "probation" | "onboarding" | "exceptions";
type Step = "stepRun" | "stepCheck" | "stepLock" | "stepPay" | "stepDeliver";

const PEOPLE_DESK: Role[] = ["ADMIN", "HR"];
const STEPS: Step[] = ["stepRun", "stepCheck", "stepLock", "stepPay", "stepDeliver"];
const REASON_KEY = {
  NO_PUNCH: "reasonNO_PUNCH",
  LATE: "reasonLATE",
  STILL_IN: "reasonSTILL_IN",
  QUESTIONABLE_TIME: "reasonQUESTIONABLE_TIME",
} as const;
const REASON_TONE: Record<ExceptionReason, Tone> = { NO_PUNCH: "bad", LATE: "waiting", STILL_IN: "waiting", QUESTIONABLE_TIME: "bad" };

// A questionable punch is found by its arrival, so its link opens that filter of the person's month.
function exceptionHref(row: Exception): string {
  return row.reason === "QUESTIONABLE_TIME" ? `/attendance/${row.employeeId}?flag=questionableTime` : `/attendance/${row.employeeId}`;
}
const kPileRows = 6;
const kClockMs = 60_000;
const kAttentionMs = 300_000;
const kSoonDays = 7;

/** A section whose endpoint this deployment lacks answers null and hides, rather than failing. */
async function unlessMissing<T>(path: string): Promise<T | null> {
  try {
    return (await api.get<T>(path)).data;
  } catch (fell: unknown) {
    if (isAxiosError(fell) && fell.response?.status === 404) {
      return null;
    }
    throw fell;
  }
}

// Kumo draws each line at a random width and pace, which the server render cannot match.

function periodName(period: { year: number; month: number }): string {
  return `${String(period.month).padStart(2, "0")}/${period.year}`;
}

function SkeletonRows({ rows = 4 }: { rows?: number }) {
  return (
    <ul aria-hidden className="flex flex-col">
      {Array.from({ length: rows }, (_, at) => (
        <li key={at} className="flex min-h-11 items-center justify-between gap-4 border-b border-kumo-hairline px-4 last:border-0">
          <SkeletonLine minWidth={45} maxWidth={45} />
          <SkeletonLine minWidth={15} maxWidth={15} />
        </li>
      ))}
    </ul>
  );
}

function Quiet({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-center gap-2.5 px-4 py-3.5 text-kumo-subtle">
      <CheckCircleIcon size={18} weight="fill" className="shrink-0 text-kumo-success" aria-hidden />
      {children}
    </p>
  );
}

/** Card anatomy of both home pages: a title strip with one link at its right, rows in the body. */
interface CardLink {
  label: string;
  href?: string;
  /** Opens the full list in place when no page holds it. */
  onPick?: () => void;
}

function Card({ title, link, children }: { title: ReactNode; link?: CardLink; children: ReactNode }) {
  const face = "shrink-0 font-normal text-kumo-link hover:underline";
  return (
    <LayerCard>
      <LayerCard.Secondary className="justify-between gap-3">
        <span className="flex min-w-0 items-center gap-2">{title}</span>
        {link?.href ? (
          <Link href={link.href} className={face}>
            {link.label}
          </Link>
        ) : link?.onPick ? (
          <button type="button" onClick={link.onPick} className={face}>
            {link.label}
          </button>
        ) : null}
      </LayerCard.Secondary>
      <LayerCard.Primary className="gap-0 p-0 pr-0">{children}</LayerCard.Primary>
    </LayerCard>
  );
}

interface Figure {
  key: string;
  label: string;
  value: number | undefined;
  href?: string;
  onPick?: () => void;
  share?: number;
}

/** Today's four numbers: rows in a narrow card, one line of four in a wide one. */
function Figures({ figures }: { figures: Figure[] }) {
  const t = useTranslations("overview");
  const locale = useLocale();
  const face =
    "flex w-full min-h-11 flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5 text-start hover:bg-kumo-tint motion-press @xl:flex-col @xl:flex-nowrap @xl:items-start @xl:gap-1 @xl:py-3.5";
  return (
    <div className="@container">
      <ul className="grid @xl:grid-cols-4">
        {figures.map((one) => {
          const body = (
            <>
              <span className="min-w-0 flex-1 @xl:flex-none @xl:text-sm @xl:text-kumo-subtle">{one.label}</span>
              {one.value === undefined ? (
                <span className="w-16 @xl:w-24">
                  <SkeletonLine minWidth={100} maxWidth={100} />
                </span>
              ) : (
                <span className="shrink-0 font-medium tabular-nums @xl:text-xl @xl:font-semibold">
                  {one.share === undefined ? t("people", { count: one.value }) : t("presentOf", { present: one.value, expected: one.share })}
                </span>
              )}
              <CaretRightIcon size={14} className="shrink-0 text-kumo-subtle @xl:hidden" aria-hidden />
              {one.share !== undefined && one.value !== undefined ? (
                <span className="flex basis-full items-center gap-2 @xl:w-full @xl:basis-auto">
                  <Bar value={one.value} max={one.share} />
                  <span className="shrink-0 text-sm text-kumo-subtle tabular-nums">{percent(one.share ? one.value / one.share : 0, locale)}</span>
                </span>
              ) : null}
            </>
          );
          return (
            <li key={one.key} className="flex border-b border-kumo-hairline last:border-b-0 @xl:border-e @xl:border-b-0 @xl:last:border-e-0">
              {one.href ? (
                <Link href={one.href} className={face}>
                  {body}
                </Link>
              ) : (
                <button type="button" onClick={one.onPick} className={face}>
                  {body}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Bar({ value, max }: { value: number; max: number }) {
  const width = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <span aria-hidden className="relative h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-kumo-fill">
      <span className="absolute inset-y-0 start-0 rounded-full bg-kumo-success" style={{ width: `${width}%` }} />
    </span>
  );
}

type Bucket = "absent" | "onLeave";

function WhoSheet({ bucket, onClose, day }: { bucket: Bucket | null; onClose: () => void; day: string }) {
  const t = useTranslations("overview");
  const format = useFormatter();
  const team = useQuery({
    queryKey: ["reports", "team-today"],
    enabled: bucket !== null,
    queryFn: async () => (await api.get<TeamToday>("/reports/team-today")).data,
  });
  const held = team.data;
  const groups = !held
    ? []
    : bucket === "onLeave"
      ? ([["sheetOnLeave", "onLeave", held.onLeave, held.totals.onLeave]] as const)
      : ([
          ["absentPastDue", "absent", held.absent, held.totals.absent],
          ["absentNotYet", "notPunched", held.notPunched, held.totals.notPunched],
        ] as const);
  const shown = groups.filter(([, , , total]) => total > 0);

  return (
    <LayerDialog.Root open={bucket !== null} onOpenChange={(next) => !next && onClose()}>
      <LayerDialog.Content>
        <LayerDialog.Title>{bucket === "onLeave" ? t("leaveTitle") : t("absentTitle")}</LayerDialog.Title>
        <LayerDialog.Description>
          {format.dateTime(dayOnly(day), { weekday: "long", day: "numeric", month: "long" })}.{" "}
          {bucket === "onLeave" ? t("leaveLead") : t("absentLead")}
        </LayerDialog.Description>
        <LayerDialog.Body>
          {team.isError ? (
            <Failed onRetry={() => void team.refetch()} />
          ) : !held ? (
            <div className="flex flex-col gap-3 py-1">
              <SkeletonLine minWidth={50} maxWidth={50} />
              <SkeletonLine minWidth={47} maxWidth={47} />
              <SkeletonLine minWidth={52} maxWidth={52} />
            </div>
          ) : shown.length === 0 ? (
            <p className="text-kumo-subtle">{bucket === "onLeave" ? t("leaveNone") : t("absentNone")}</p>
          ) : (
            <div className="flex flex-col gap-4">
              {shown.map(([key, bucket, people, count]) => (
                <section key={key} className="flex flex-col gap-1">
                  <h3 className="m-0 text-sm font-medium text-kumo-subtle">
                    {t(key)} · <span className="tabular-nums">{format.number(count)}</span>
                  </h3>
                  <BucketList bucket={bucket} people={people} total={count} />
                </section>
              ))}
            </div>
          )}
        </LayerDialog.Body>
      </LayerDialog.Content>
    </LayerDialog.Root>
  );
}

/** One bucket of the sheet: the preview's first names, then the rest a page at a time by code. */
function BucketList({ bucket, people, total }: { bucket: TeamBucket; people: readonly PersonRef[]; total: number }) {
  const t = useTranslations("overview");
  const common = useTranslations("common");
  const [more, setMore] = useState(false);
  const rest = useInfiniteQuery({
    queryKey: ["reports", "team-today", bucket],
    enabled: more,
    initialPageParam: people.at(-1)?.code ?? "",
    queryFn: async ({ pageParam }) =>
      (await api.get<PersonPage>(`/reports/team-today/${bucket}?take=${kBucketPage}&cursor=${encodeURIComponent(pageParam)}`)).data,
    getNextPageParam: (last) => last.next ?? undefined,
  });
  const listed = [...people, ...(rest.data?.pages.flatMap((page) => page.rows) ?? [])];

  return (
    <>
      <ul className="-mx-2 flex flex-col">
        {listed.map((one) => (
          <li key={one.id}>
            <Link
              href={`/employees/${one.id}`}
              className="flex min-h-10 items-center gap-3 rounded-md px-2 hover:bg-kumo-tint motion-press"
            >
              <span className="min-w-0 flex-1 truncate">{one.fullName}</span>
              <span className="shrink-0 font-mono text-sm text-kumo-subtle">{one.code}</span>
            </Link>
          </li>
        ))}
      </ul>
      {listed.length < total ? (
        <div className="flex items-center justify-between gap-3 text-sm text-kumo-subtle">
          <span className="tabular-nums">{t("absentShownOf", { shown: listed.length, total })}</span>
          <Button
            size="sm"
            variant="secondary"
            loading={rest.isFetching}
            onClick={() => (more ? void rest.fetchNextPage() : setMore(true))}
          >
            {common("loadMore")}
          </Button>
        </div>
      ) : null}
    </>
  );
}

function TodayCard({ asked }: { asked: UseQueryResult<Today | null> }) {
  const t = useTranslations("overview");
  const { role, employeeId } = useSession();
  const [listing, setListing] = useState<Bucket | null>(null);

  if (asked.data === null) {
    return null;
  }
  const today = asked.data;
  const day = today?.date ?? todayIso();
  const range = `from=${day}&to=${day}`;
  // Payroll staff cannot open the leave ledger, so their leave count lists the names in place.
  const leaveHref = allows(role, employeeId !== null, "/leave") ? `/leave?kind=LEAVE&state=APPROVED&${range}` : undefined;
  const figures: Figure[] = [
    { key: "present", label: t("present"), value: today?.present, share: today?.expected ?? 0, href: `/attendance?${range}` },
    { key: "late", label: t("late"), value: today?.late, href: `/attendance?${range}&show=late` },
    { key: "absent", label: t("absent"), value: today?.absentUnexcused, onPick: () => setListing("absent") },
    { key: "leave", label: t("onLeave"), value: today?.onLeave, href: leaveHref, onPick: () => setListing("onLeave") },
  ];

  return (
    <Card title={t("todayTitle")}>
      {asked.isError ? (
        <div className="p-4">
          <Failed onRetry={() => void asked.refetch()} />
        </div>
      ) : (
        <Figures figures={figures} />
      )}
      <WhoSheet bucket={listing} onClose={() => setListing(null)} day={day} />
    </Card>
  );
}

function PileList({ pile }: { pile: Pile }) {
  const t = useTranslations("overview");
  if (pile.rows.length === 0) {
    return <Quiet>{t("attentionClear")}</Quiet>;
  }
  return (
    <div className="flex flex-col motion-enter">
      <ul className="flex flex-col">
        {pile.rows.slice(0, kPileRows).map((row) => (
          <li key={row.key} className="border-b border-kumo-hairline last:border-0">
            <Link href={row.href} className="flex min-h-12 items-center gap-3 px-4 py-2 hover:bg-kumo-tint motion-press">
              <span className="flex min-w-0 flex-1 flex-col md:flex-row md:items-baseline md:gap-2">
                <span className="truncate">{row.name}</span>
                <span className="flex min-w-0 items-baseline text-sm text-kumo-subtle">
                  <span className="shrink-0 font-mono">{row.code}</span>
                  {row.detail ? <span className="truncate whitespace-pre"> · {row.detail}</span> : null}
                </span>
              </span>
              <span className="shrink-0 text-end tabular-nums">{row.aside}</span>
            </Link>
          </li>
        ))}
      </ul>
      {pile.hint ? (
        <p className="border-t border-kumo-hairline px-4 py-2.5 text-sm text-pretty text-kumo-subtle">{pile.hint}</p>
      ) : null}
    </div>
  );
}

/** One card, one tab per pile of work: the tab that is open is all the card shows. */
function Piles<K extends string>({ title, piles, pending, failed, onRetry }: {
  title: string;
  piles: [K, Pile | null][];
  pending: boolean;
  failed: boolean;
  onRetry: () => void;
}) {
  const t = useTranslations("overview");
  const format = useFormatter();
  const shown = piles.filter((entry): entry is [K, Pile] => entry[1] !== null);
  const [tab, setTab] = useState<K | null>(null);
  const current = shown.find(([key]) => key === tab) ?? shown[0];

  if (!pending && !failed && shown.length === 0) {
    return null;
  }
  const full = current?.[1].full;
  const onAll = current?.[1].onAll;
  const countOf = (pile: Pile) => `${format.number(pile.total)}${pile.exact ? "" : "+"}`;
  return (
    <Card
      title={title}
      link={
        current && (full || onAll) ? { href: full, onPick: onAll, label: t(current[1].exact ? "fullListOf" : "fullListAtLeast", { count: current[1].total }) } : undefined
      }
    >
      {failed ? (
        <div className="p-4">
          <Failed onRetry={onRetry} />
        </div>
      ) : pending || !current ? (
        <SkeletonRows rows={kPileRows} />
      ) : (
        <>
          <div className="@container border-b border-kumo-hairline px-3 py-2.5">
            <div className="hidden @xl:block">
              <Tabs
                variant="segmented"
                value={current[0]}
                onValueChange={(next) => setTab(next as K)}
                tabs={shown.map(([key, pile]) => ({
                  value: key,
                  label: (
                    <span className="flex items-center gap-1.5 whitespace-nowrap">
                      {pile.label}
                      <span className="text-kumo-subtle tabular-nums">{countOf(pile)}</span>
                    </span>
                  ),
                }))}
              />
            </div>
            <div role="tablist" className="grid grid-cols-2 gap-1 rounded-lg bg-kumo-recessed p-1 @xl:hidden">
              {shown.map(([key, pile]) => (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  aria-selected={key === current[0]}
                  onClick={() => setTab(key)}
                  className={cn(
                    "flex min-h-11 min-w-0 items-center justify-between gap-2 rounded-md px-3 text-start",
                    key === current[0]
                      ? "bg-kumo-base font-medium text-kumo-default shadow-sm ring ring-kumo-line"
                      : "text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-default",
                  )}
                >
                  <span className="truncate">{pile.label}</span>
                  <span className="shrink-0 tabular-nums">{countOf(pile)}</span>
                </button>
              ))}
            </div>
          </div>
          <PileList key={current[0]} pile={current[1]} />
        </>
      )}
    </Card>
  );
}

function HrCard() {
  const [allExceptions, setAllExceptions] = useState(false);
  const t = useTranslations("overview");
  const kinds = useTranslations("employees");
  const format = useFormatter();
  const attention = useQuery({
    queryKey: ["reports", "attention"],
    refetchInterval: kAttentionMs,
    queryFn: () => unlessMissing<Attention>("/reports/attention"),
  });
  const overdue = useQuery({
    queryKey: ["checklists", "open", "overdue", kPileRows],
    queryFn: () => unlessMissing<Heap<OverdueTask>>(`/checklists/open?overdue=true&take=${kPileRows}`),
  });
  const short = (iso: string) => format.dateTime(dayOnly(iso), { day: "numeric", month: "numeric" });

  const ending = (label: string, heap: Heap<Expiring>, which: string, hint: string): Pile => ({
    label,
    hint,
    total: heap.total,
    exact: heap.totalIsExact,
    full: `/employees?ending=${which}`,
    rows: heap.rows.map((row) => ({
      key: row.contractId,
      href: `/employees/${row.employeeId}?tab=contracts`,
      name: row.fullName,
      code: row.code,
      detail: kinds(`kind${row.kind}`),
      aside: (
        <span className="flex items-baseline gap-2">
          <span className="text-sm text-kumo-subtle">{short(row.endsOn)}</span>
          <span className={cn("min-w-20", row.daysLeft <= kSoonDays && "font-medium")}>{t("daysLeft", { count: row.daysLeft })}</span>
        </span>
      ),
    })),
  });
  const held = attention.data;
  const piles: [HrTab, Pile | null][] = [
    ["contracts", held ? ending(t("tabContracts"), held.contractsEnding, "contract", t("contractsHint")) : null],
    ["probation", held ? ending(t("tabProbation"), held.probationEnding, "probation", t("probationHint")) : null],
    [
      "onboarding",
      overdue.data
        ? {
            label: t("tabOnboarding"),
            total: overdue.data.total,
            exact: overdue.data.totalIsExact,
            full: "/onboarding?pick=late",
            rows: overdue.data.rows.map((task) => ({
              key: task.id,
              href: `/employees/${task.run.employee.id}?tab=checklist`,
              name: task.run.employee.fullName,
              code: task.run.employee.code,
              detail: task.title,
              aside: <span className="text-kumo-danger">{t("dueOn", { date: short(task.dueOn) })}</span>,
            })),
          }
        : null,
    ],
    [
      "exceptions",
      held
        ? {
            label: t("tabExceptions"),
            total: held.exceptionsToday.total,
            exact: held.exceptionsToday.totalIsExact,
            hint: t("exceptionsHint"),
            onAll: () => setAllExceptions(true),
            rows: held.exceptionsToday.rows.map((row) => ({
              key: String(row.employeeId),
              href: exceptionHref(row),
              name: row.fullName,
              code: row.code,
              detail: row.receivedAt ? t("heardAt", { time: format.dateTime(new Date(row.receivedAt), "clock") }) : undefined,
              aside: (
                <StatePill tone={REASON_TONE[row.reason]}>
                  {row.reason === "LATE" && row.minutes > 0 ? t("lateBy", { minutes: row.minutes }) : t(REASON_KEY[row.reason])}
                </StatePill>
              ),
            })),
          }
        : null,
    ],
  ];

  return (
    <>
      <Piles
        title={t("hrTitle")}
        piles={piles}
        pending={attention.isPending}
        failed={attention.isError}
        onRetry={() => void attention.refetch()}
      />
      <ExceptionsSheet open={allExceptions} onClose={() => setAllExceptions(false)} />
    </>
  );
}

/** Today's exceptions in full, a page at a time by code; the card caps them at 200. */
function ExceptionsSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useTranslations("overview");
  const common = useTranslations("common");
  const format = useFormatter();
  const list = useInfiniteQuery({
    queryKey: ["reports", "attention", "exceptions"],
    enabled: open,
    initialPageParam: "",
    queryFn: async ({ pageParam }) =>
      (await api.get<ExceptionPage>(`/reports/attention/exceptions?take=${kBucketPage}&cursor=${encodeURIComponent(pageParam)}`)).data,
    getNextPageParam: (last) => last.next ?? undefined,
  });
  const rows = list.data?.pages.flatMap((page) => page.rows) ?? [];
  const total = list.data?.pages[0]?.total ?? 0;

  return (
    <LayerDialog.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <LayerDialog.Content closeLabel={common("close")}>
        <LayerDialog.Title>{t("tabExceptions")}</LayerDialog.Title>
        <LayerDialog.Description>{t("exceptionsHint")}</LayerDialog.Description>
        <LayerDialog.Body>
          {list.isError ? (
            <Failed onRetry={() => void list.refetch()} />
          ) : list.isPending ? (
            <div className="flex flex-col gap-3 py-1">
              <SkeletonLine minWidth={50} maxWidth={50} />
              <SkeletonLine minWidth={47} maxWidth={47} />
              <SkeletonLine minWidth={52} maxWidth={52} />
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <ul className="-mx-2 flex flex-col">
                {rows.map((row) => (
                  <li key={row.employeeId}>
                    <Link
                      href={exceptionHref(row)}
                      className="flex min-h-10 items-center gap-3 rounded-md px-2 hover:bg-kumo-tint motion-press"
                    >
                      <span className="min-w-0 flex-1 truncate">{row.fullName}</span>
                      <span className="shrink-0 font-mono text-sm text-kumo-subtle">{row.code}</span>
                      {row.receivedAt ? (
                        <span className="shrink-0 text-sm text-kumo-subtle tabular-nums">
                          {t("heardAt", { time: format.dateTime(new Date(row.receivedAt), "clock") })}
                        </span>
                      ) : null}
                      <StatePill tone={REASON_TONE[row.reason]}>
                        {row.reason === "LATE" && row.minutes > 0 ? t("lateBy", { minutes: row.minutes }) : t(REASON_KEY[row.reason])}
                      </StatePill>
                    </Link>
                  </li>
                ))}
              </ul>
              {rows.length < total ? (
                <div className="flex items-center justify-between gap-3 text-sm text-kumo-subtle">
                  <span className="tabular-nums">{t("absentShownOf", { shown: rows.length, total })}</span>
                  <Button size="sm" variant="secondary" loading={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
                    {common("loadMore")}
                  </Button>
                </div>
              ) : null}
            </div>
          )}
        </LayerDialog.Body>
      </LayerDialog.Content>
    </LayerDialog.Root>
  );
}

function stepOf(period: Period, runs: Run[] | undefined, blockers: Blocker[] | undefined): Step {
  if (period.state === "PAID") {
    return "stepDeliver";
  }
  if (period.state === "LOCKED") {
    return "stepPay";
  }
  if (!runs?.some((run) => run.kind === "REGULAR" && run.state === "DONE")) {
    return "stepRun";
  }
  return blockers?.some((item) => item.count > 0) ? "stepCheck" : "stepLock";
}

function Stepper({ now }: { now: Step }) {
  const pay = useTranslations("payroll");
  const at = STEPS.indexOf(now);
  return (
    <ol className="grid grid-cols-5 gap-1 px-4 pt-3.5 pb-3">
      {STEPS.map((step, index) => (
        <li key={step} className="flex min-w-0 flex-col gap-1.5" aria-current={index === at ? "step" : undefined}>
          <span className={cn("h-1 rounded-full", index < at ? "bg-kumo-success" : index === at ? "bg-kumo-warning" : "bg-kumo-fill")} />
          <span
            className={cn(
              "flex min-w-0 items-center gap-1 truncate text-sm",
              index === at ? "font-medium text-kumo-default" : "text-kumo-subtle",
            )}
          >
            {index < at ? <CheckIcon size={12} className="shrink-0 text-kumo-success" aria-hidden /> : null}
            {pay(step)}
          </span>
        </li>
      ))}
    </ol>
  );
}

function PeriodCard() {
  const t = useTranslations("overview");
  const nav = useTranslations("nav");
  const pay = useTranslations("payroll");
  const format = useFormatter();
  const periods = useQuery({
    queryKey: ["payroll-periods"],
    queryFn: () => unlessMissing<Period[]>("/payroll-periods"),
  });
  const open = periods.data?.find((one) => one.state === "OPEN");
  const runs = useQuery({
    queryKey: ["payroll-periods", open?.id, "runs"],
    enabled: open !== undefined,
    queryFn: async () => (await api.get<Run[]>(`/payroll-periods/${open?.id}/runs`)).data,
  });
  const checklist = useQuery({
    queryKey: ["payroll-periods", open?.id, "checklist"],
    enabled: open !== undefined,
    queryFn: async () => (await api.get<Blocker[]>(`/payroll-periods/${open?.id}/checklist`)).data,
  });

  if (periods.data === null) {
    return null;
  }
  const blockers = (checklist.data ?? []).filter((item) => item.count > 0);
  return (
    <Card
      title={open ? t("periodTitle", { name: periodName(open) }) : t("tabPeriod")}
      link={open ? { href: `/payroll/${open.id}`, label: t("periodGo", { name: periodName(open) }) } : { href: "/payroll", label: nav("payroll") }}
    >
      {periods.isError ? (
        <div className="p-4">
          <Failed onRetry={() => void periods.refetch()} />
        </div>
      ) : periods.isPending || (open && (runs.isPending || checklist.isPending)) ? (
        <SkeletonRows rows={3} />
      ) : !open ? (
        <p className="px-4 py-3.5 text-kumo-subtle">{t("periodNone")}</p>
      ) : (
        <div className="flex flex-col motion-enter">
          <Stepper now={stepOf(open, runs.data, checklist.data)} />
          <p className="border-t border-kumo-hairline px-4 pt-3 pb-1 text-sm font-medium text-kumo-subtle">{t("blockersTitle")}</p>
          {blockers.length === 0 ? (
            <Quiet>{pay("checklistClear")}</Quiet>
          ) : (
            <ul className="flex flex-col">
              {blockers.map((item) => (
                <li key={item.code} className="border-b border-kumo-hairline last:border-0">
                  <Link href={`/payroll/${open.id}`} className="flex min-h-11 items-center gap-3 px-4 hover:bg-kumo-tint motion-press">
                    <span className="min-w-0 flex-1 truncate">{pay(item.code)}</span>
                    <span className="shrink-0 font-medium tabular-nums">{format.number(item.count)}</span>
                    <CaretRightIcon size={14} className="shrink-0 text-kumo-subtle" aria-hidden />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Card>
  );
}

function FleetCard() {
  const t = useTranslations("overview");
  const common = useTranslations("common");
  const counts = useQuery({
    queryKey: ["devices", "counts"],
    queryFn: () => unlessMissing<DeviceCounts>("/devices/counts"),
  });
  const fleet = useQuery({
    queryKey: ["releases", "fleet"],
    queryFn: () => unlessMissing<FleetUpdate[]>("/releases/fleet"),
  });
  if (counts.data === null) {
    return null;
  }
  const held = counts.data;
  const behind = new Set((fleet.data ?? []).flatMap((one) => [...one.behind, ...one.updating])).size;
  const rows = held
    ? [
        { key: "online", label: t("fleetOnline"), value: t("fleetOf", { count: held.online, total: held.APPROVED }), href: "/devices?show=online" },
        { key: "offline", label: t("fleetOffline"), value: t("machines", { count: held.offline }), href: "/devices?show=offline", warn: held.offline > 0 },
        { key: "pending", label: t("fleetPending"), value: t("machines", { count: held.PENDING }), href: "/devices?show=PENDING", warn: held.PENDING > 0 },
        { key: "behind", label: t("fleetBehindRow"), value: t("machines", { count: behind }), href: "/devices" },
      ]
    : [];
  return (
    <Card title={t("fleetTitle")} link={{ href: "/devices", label: common("seeAll") }}>
      {counts.isError ? (
        <div className="p-4">
          <Failed onRetry={() => void counts.refetch()} />
        </div>
      ) : !held ? (
        <SkeletonRows rows={4} />
      ) : (
        <ul className="flex flex-col">
          {rows.map((row) => (
            <li key={row.key} className="border-b border-kumo-hairline last:border-0">
              <Link href={row.href} className="flex min-h-11 items-center gap-3 px-4 hover:bg-kumo-tint motion-press">
                <span className="min-w-0 flex-1 truncate">{row.label}</span>
                <span className={cn("shrink-0 font-medium tabular-nums", row.warn && "text-kumo-warning")}>{row.value}</span>
                <CaretRightIcon size={14} className="shrink-0 text-kumo-subtle" aria-hidden />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** The desk roles' home: work in the main column, today and the fleet beside it (KEHOACH 9.10). */
export default function OverviewPage() {
  const t = useTranslations("overview");
  const format = useFormatter();
  const now = useNow({ updateInterval: kClockMs });
  const role = useSession((s) => s.role);
  const today = useQuery({
    queryKey: ["reports", "today"],
    refetchInterval: kAttentionMs,
    queryFn: () => unlessMissing<Today>("/reports/today"),
  });
  const side = [<TodayCard key="today" asked={today} />, ...(role === "ADMIN" ? [<FleetCard key="fleet" />] : [])];

  return (
    <>
      <PageHeader
        title={t("title")}
        description={format.dateTime(now, { weekday: "long", day: "numeric", month: "long", year: "numeric" })}
      />
      <PageLayout
        aside={<div className={cn("grid items-start gap-4", side.length > 1 && "@2xl/page:grid-cols-2 @5xl/page:grid-cols-1")}>{side}</div>}
      >
        <div className="flex flex-col gap-4">
          {role !== null && REQUEST_DECIDERS.includes(role) ? <InboxPreview /> : null}
          {role !== null && PEOPLE_DESK.includes(role) ? <HrCard /> : null}
          {role === "PAYROLL" ? <PeriodCard /> : null}
        </div>
      </PageLayout>
    </>
  );
}
