"use client";

import { Checkbox, SkeletonLine } from "@cloudflare/kumo";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";

import { Failed } from "@/components/ui/failed";
import { useNotify } from "@/components/ui/notify";
import { api } from "@/lib/api";
import type { NoticeKind } from "./notice-list";

// Email is in the enum but nobody delivers it (KEHOACH 9.21.4).
type Channel = "IN_APP" | "PUSH";

interface Preference {
  kind: NoticeKind;
  channel: Channel;
  on: boolean;
}

const KIND_KEY: Record<
  NoticeKind,
  | "kindREQUEST_WAITING"
  | "kindREQUEST_STALLED"
  | "kindPAYSLIP_ISSUED"
  | "kindCONTRACT_ENDING"
  | "kindDISPUTE_ANSWERED"
  | "kindREQUEST_DECIDED_true"
> = {
  REQUEST_DECIDED: "kindREQUEST_DECIDED_true",
  REQUEST_WAITING: "kindREQUEST_WAITING",
  REQUEST_STALLED: "kindREQUEST_STALLED",
  PAYSLIP_ISSUED: "kindPAYSLIP_ISSUED",
  CONTRACT_ENDING: "kindCONTRACT_ENDING",
  DISPUTE_ANSWERED: "kindDISPUTE_ANSWERED",
};

const CHANNEL_KEY: Record<Channel, "channelIN_APP" | "channelPUSH"> = {
  IN_APP: "channelIN_APP",
  PUSH: "channelPUSH",
};

const KINDS: NoticeKind[] = [
  "REQUEST_DECIDED",
  "REQUEST_WAITING",
  "REQUEST_STALLED",
  "PAYSLIP_ISSUED",
  "CONTRACT_ENDING",
  "DISPUTE_ANSWERED",
];
const CHANNELS: Channel[] = ["IN_APP", "PUSH"];
const PREFS_KEY = ["notifications", "preferences"];
const kContractDays = 30;
const kStalledDays = 7;

export function NoticePreferences() {
  const t = useTranslations("notices");
  const cache = useQueryClient();
  const notify = useNotify();

  const prefs = useQuery({
    queryKey: PREFS_KEY,
    queryFn: async () => (await api.get<Preference[]>("/notifications/preferences")).data,
  });

  // The box flips at once and flips back if the api refuses, so a tap never looks ignored.
  const set = useMutation({
    mutationFn: (body: Preference) => api.post("/notifications/preferences", body),
    onMutate: async (body) => {
      await cache.cancelQueries({ queryKey: PREFS_KEY });
      const was = cache.getQueryData<Preference[]>(PREFS_KEY);
      cache.setQueryData<Preference[]>(PREFS_KEY, (held) => [
        ...(held ?? []).filter((row) => row.kind !== body.kind || row.channel !== body.channel),
        body,
      ]);
      return { was };
    },
    onSuccess: () => notify.done(t("prefsSaved")),
    onError: (fell: unknown, _body, held) => {
      cache.setQueryData(PREFS_KEY, held?.was);
      notify.failed(fell);
    },
    onSettled: () => void cache.invalidateQueries({ queryKey: PREFS_KEY }),
  });

  function on(kind: NoticeKind, channel: Channel): boolean {
    return prefs.data?.find((row) => row.kind === kind && row.channel === channel)?.on ?? false;
  }

  function name(kind: NoticeKind): string {
    if (kind === "CONTRACT_ENDING") {
      return t(KIND_KEY[kind], { count: kContractDays });
    }
    return kind === "REQUEST_STALLED" ? t(KIND_KEY[kind], { count: kStalledDays }) : t(KIND_KEY[kind]);
  }

  if (prefs.isError) {
    return <Failed onRetry={() => void prefs.refetch()} />;
  }

  return (
    <div role="table" aria-label={t("prefsTitle")} className="flex flex-col">
      <div role="row" className="grid grid-cols-[1fr_4.5rem_4.5rem] items-end gap-2 pb-2 text-sm text-kumo-subtle">
        <span role="columnheader" />
        {CHANNELS.map((channel) => (
          <span key={channel} role="columnheader" className="text-center">
            {t(CHANNEL_KEY[channel])}
          </span>
        ))}
      </div>
      {KINDS.map((kind) => (
        <div
          key={kind}
          role="row"
          className="grid min-h-11 grid-cols-[1fr_4.5rem_4.5rem] items-center gap-2 border-t border-kumo-hairline py-1"
        >
          <span role="rowheader" className="min-w-0">
            {name(kind)}
          </span>
          {CHANNELS.map((channel) => (
            <span key={channel} role="cell" className="flex justify-center">
              {prefs.isPending ? (
                <SkeletonLine minWidth={22} maxWidth={22} />
              ) : (
                <Checkbox
                  aria-label={`${name(kind)} · ${t(CHANNEL_KEY[channel])}`}
                  checked={on(kind, channel)}
                  onCheckedChange={(checked: boolean) => set.mutate({ kind, channel, on: checked })}
                />
              )}
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}
