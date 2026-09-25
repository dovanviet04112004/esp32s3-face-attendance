"use client";

import { Banner, Button, LayerDialog, Select } from "@cloudflare/kumo";
import { PlusIcon, TrashIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { useState } from "react";

import { DateField } from "@/components/ui/date-field";
import { Failed } from "@/components/ui/failed";
import { useNotify } from "@/components/ui/notify";
import { StatePill, type Tone } from "@/components/ui/pill";
import { SkeletonLine } from "@/components/ui/skeleton";
import { Link } from "@/i18n/navigation";
import { api } from "@/lib/api";
import { useFault } from "@/lib/fault";
import { clockOf, dayOnly, todayIso } from "@/lib/format";

interface Shift {
  id: string;
  name: string;
  startTime: string;
  endTime: string;
  active: boolean;
}

interface Held {
  id: string;
  validFrom: string;
  validTo: string | null;
  shift: Shift;
}

type Standing = "current" | "upcoming" | "replaced" | "ended";

const STANDING_TONE: Record<Standing, Tone> = { current: "good", upcoming: "waiting", replaced: "idle", ended: "idle" };
const STANDING_KEY = {
  current: "shiftCurrent",
  upcoming: "shiftUpcoming",
  replaced: "shiftReplaced",
  ended: "shiftEnded",
} as const;
const kPastShown = 2;

// The list comes latest start first, so the first one covering today is the one in force (KEHOACH 9.8).
function standingOf(held: Held[], today: string): Map<string, Standing> {
  const standing = new Map<string, Standing>();
  let found = false;
  for (const one of held) {
    const from = one.validFrom.slice(0, 10);
    const ended = one.validTo !== null && one.validTo.slice(0, 10) < today;
    if (from > today) {
      standing.set(one.id, "upcoming");
    } else if (ended) {
      standing.set(one.id, "ended");
    } else if (!found) {
      standing.set(one.id, "current");
      found = true;
    } else {
      standing.set(one.id, "replaced");
    }
  }
  return standing;
}

/** A person's shifts on their profile, set and dropped there (KEHOACH 9.15). */
export function ShiftCard({ employeeId, fullName }: { employeeId: number; fullName: string }) {
  const t = useTranslations("employees");
  const s = useTranslations("shifts");
  const common = useTranslations("common");
  const format = useFormatter();
  const locale = useLocale();
  const cache = useQueryClient();
  const notify = useNotify();
  const faultOf = useFault();
  const [open, setOpen] = useState(false);
  const [shiftId, setShiftId] = useState("");
  const [validFrom, setValidFrom] = useState("");
  const [validTo, setValidTo] = useState("");
  const [tried, setTried] = useState(false);
  const [fault, setFault] = useState<string | null>(null);
  const [dropping, setDropping] = useState<Held | null>(null);

  const held = useQuery({
    queryKey: ["shifts", "people", employeeId],
    queryFn: async () => (await api.get<Held[]>(`/shifts/people/${employeeId}`)).data,
  });

  const shifts = useQuery({
    queryKey: ["shifts"],
    queryFn: async () => (await api.get<Shift[]>("/shifts")).data,
  });
  const offered = shifts.data?.filter((one) => one.active) ?? [];
  const hours = (one: Shift) => `${clockOf(one.startTime, locale)} – ${clockOf(one.endTime, locale)}`;

  function refresh(): void {
    void cache.invalidateQueries({ queryKey: ["shifts"] });
    void cache.invalidateQueries({ queryKey: ["me"] });
  }

  const assign = useMutation({
    mutationFn: () =>
      api.post(`/shifts/${shiftId}/assignments`, {
        employeeId,
        validFrom: new Date(`${validFrom}T00:00:00.000Z`).toISOString(),
        ...(validTo ? { validTo: new Date(`${validTo}T00:00:00.000Z`).toISOString() } : {}),
      }),
    onSuccess: () => {
      const shift = offered.find((one) => one.id === shiftId);
      notify.done(t("shiftAssigned", { name: fullName, shift: shift?.name ?? "" }));
      setOpen(false);
      refresh();
    },
    onError: (fell: unknown) => setFault(faultOf(fell)),
  });

  const unassign = useMutation({
    mutationFn: (one: Held) => api.delete(`/shifts/${one.shift.id}/assignments/${one.id}`),
    onSuccess: (_, one) => {
      notify.done(s("unassignedDone", { name: fullName, shift: one.shift.name }));
      setDropping(null);
      refresh();
    },
    onError: notify.failed,
  });

  function start(): void {
    setFault(null);
    setTried(false);
    setShiftId(offered[0]?.id ?? "");
    setValidFrom(todayIso());
    setValidTo("");
    setOpen(true);
  }

  function send(): void {
    setTried(true);
    if (!shiftId || validFrom === "") {
      return;
    }
    setFault(null);
    assign.mutate();
  }

  if (held.isError) {
    return <Failed onRetry={() => void held.refetch()} />;
  }

  const standing = standingOf(held.data ?? [], todayIso());
  const bygone = (one: Held) => ["replaced", "ended"].includes(standing.get(one.id) ?? "ended");
  const past = (held.data ?? []).filter(bygone).slice(0, kPastShown);
  const shown = (held.data ?? []).filter((one) => !bygone(one) || past.includes(one));

  return (
    <div className="flex flex-col gap-3">
      {held.isPending ? (
        <SkeletonLine minWidth={27} maxWidth={43} />
      ) : shown.length === 0 ? (
        <p className="text-kumo-subtle">{t("shiftNone")}</p>
      ) : (
        <ul className="-my-1 flex flex-col">
          {shown.map((one) => {
            const state = standing.get(one.id) ?? "ended";
            return (
              <li key={one.id} className="flex items-center justify-between gap-3 border-b border-kumo-hairline py-2 last:border-0">
                <span className="flex min-w-0 flex-col gap-1">
                  <span className="truncate">
                    {one.shift.name}
                    <span className="ms-2 text-sm text-kumo-subtle tabular-nums">{hours(one.shift)}</span>
                  </span>
                  <span className="flex flex-wrap items-center gap-2 text-sm text-kumo-subtle tabular-nums">
                    <StatePill tone={STANDING_TONE[state]}>{t(STANDING_KEY[state])}</StatePill>
                    {format.dateTime(dayOnly(one.validFrom), "day")} →{" "}
                    {one.validTo ? format.dateTime(dayOnly(one.validTo), "day") : s("openEnded")}
                  </span>
                </span>
                <Button
                  variant="ghost"
                  shape="square"
                  icon={TrashIcon}
                  aria-label={s("unassignOf", { name: one.shift.name })}
                  onClick={() => setDropping(one)}
                  className="shrink-0"
                />
              </li>
            );
          })}
        </ul>
      )}
      <Button variant="secondary" size="sm" icon={PlusIcon} disabled={offered.length === 0} onClick={start} className="self-start">
        {t("shiftAction")}
      </Button>
      {shifts.isSuccess && offered.length === 0 ? (
        <p className="text-sm text-kumo-subtle">
          {t.rich("shiftNoneDeclared", {
            link: (words) => (
              <Link href="/shifts" className="text-kumo-link hover:underline">
                {words}
              </Link>
            ),
          })}
        </p>
      ) : null}

      <LayerDialog.Root open={open} onOpenChange={setOpen} dismissDisabled={assign.isPending}>
        <LayerDialog.Content closeLabel={common("close")}>
          <LayerDialog.Title>{t("shiftAssignTitle", { name: fullName })}</LayerDialog.Title>
          <LayerDialog.Description>{t("shiftAssignLead")}</LayerDialog.Description>
          <LayerDialog.Body>
            <div className="flex flex-col gap-4">
              <Select
                label={t("shiftPick")}
                hideLabel={false}
                value={shiftId}
                onValueChange={(next) => setShiftId(String(next ?? ""))}
                items={Object.fromEntries(offered.map((one) => [one.id, `${one.name} · ${hours(one)}`]))}
                className="w-full"
              />
              <div className="grid items-start gap-4 sm:grid-cols-2">
                <DateField
                  label={s("validFrom")}
                  value={validFrom}
                  error={tried && validFrom === "" ? common("required") : undefined}
                  onChange={setValidFrom}
                />
                <DateField
                  label={s("validTo")}
                  required={false}
                  min={validFrom || undefined}
                  value={validTo}
                  description={s("validToHint")}
                  onChange={setValidTo}
                />
              </div>
              {fault ? <Banner variant="error" icon={<WarningCircleIcon weight="fill" />} title={fault} /> : null}
            </div>
          </LayerDialog.Body>
          <LayerDialog.Actions dismissLabel={common("cancel")}>
            <LayerDialog.Actions.Primary loading={assign.isPending} disabled={!shiftId} onClick={send}>
              {t("shiftAction")}
            </LayerDialog.Actions.Primary>
          </LayerDialog.Actions>
        </LayerDialog.Content>
      </LayerDialog.Root>

      <LayerDialog.Alert open={dropping !== null} onOpenChange={(next) => !next && setDropping(null)} dismissDisabled={unassign.isPending}>
        <LayerDialog.Content size="sm" closeLabel={common("close")}>
          <LayerDialog.Title>{s("unassignTitle")}</LayerDialog.Title>
          <LayerDialog.Description>
            {dropping ? s("unassignLead", { name: fullName, shift: dropping.shift.name }) : null}
          </LayerDialog.Description>
          <LayerDialog.Body>
            <p className="text-kumo-subtle">{s("unassignHint")}</p>
          </LayerDialog.Body>
          <LayerDialog.Actions dismissLabel={common("cancel")}>
            <LayerDialog.Actions.Primary variant="destructive" loading={unassign.isPending} onClick={() => dropping && unassign.mutate(dropping)}>
              {s("unassign")}
            </LayerDialog.Actions.Primary>
          </LayerDialog.Actions>
        </LayerDialog.Content>
      </LayerDialog.Alert>
    </div>
  );
}
