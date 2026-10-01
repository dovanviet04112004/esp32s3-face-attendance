"use client";

import { Checkbox } from "@cloudflare/kumo";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Fragment } from "react";

import { Failed } from "@/components/ui/failed";
import { useNotify } from "@/components/ui/notify";
import { SkeletonLine } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { NOTICE_CATEGORIES, NOTICE_LOOK, type NoticeKind } from "./kinds";

// Email is in the enum but nobody delivers it (KEHOACH 9.21.4).
type Channel = "IN_APP" | "PUSH";

interface Preference {
  kind: NoticeKind;
  channel: Channel;
  on: boolean;
}

interface Offered extends Preference {
  /** False for a work item's in-app switch, which stays on. */
  mutable: boolean;
}

const CHANNEL_KEY: Record<Channel, "channelIN_APP" | "channelPUSH"> = {
  IN_APP: "channelIN_APP",
  PUSH: "channelPUSH",
};

const CHANNELS: Channel[] = ["IN_APP", "PUSH"];
const PREFS_KEY = ["notifications", "preferences"];

export function NoticePreferences() {
  const t = useTranslations("notices");
  const cache = useQueryClient();
  const notify = useNotify();

  const prefs = useQuery({
    queryKey: PREFS_KEY,
    queryFn: async () => (await api.get<Offered[]>("/notifications/preferences")).data,
  });

  // The box flips at once and flips back if the api refuses, so a tap never looks ignored.
  const set = useMutation({
    mutationFn: (body: Preference) => api.post("/notifications/preferences", body),
    onMutate: async (body) => {
      await cache.cancelQueries({ queryKey: PREFS_KEY });
      const was = cache.getQueryData<Offered[]>(PREFS_KEY);
      cache.setQueryData<Offered[]>(PREFS_KEY, (held) =>
        (held ?? []).map((row) => (row.kind === body.kind && row.channel === body.channel ? { ...row, on: body.on } : row)),
      );
      return { was };
    },
    onSuccess: () => notify.done(t("prefsSaved")),
    onError: (fell: unknown, _body, held) => {
      cache.setQueryData(PREFS_KEY, held?.was);
      notify.failed(fell);
    },
    onSettled: () => void cache.invalidateQueries({ queryKey: PREFS_KEY }),
  });

  function cell(kind: NoticeKind, channel: Channel): Offered | undefined {
    return prefs.data?.find((row) => row.kind === kind && row.channel === channel);
  }

  function name(kind: NoticeKind): string {
    const label = NOTICE_LOOK[kind].label;
    return label.count === undefined ? t(label.key) : t(label.key, { count: label.count });
  }

  // Only the kinds this account receives come back, grouped as the bell groups them.
  const shown = (Object.keys(NOTICE_LOOK) as NoticeKind[]).filter((kind) => prefs.isPending || prefs.data?.some((row) => row.kind === kind));
  const groups = NOTICE_CATEGORIES.map((category) => ({ category, kinds: shown.filter((kind) => NOTICE_LOOK[kind].category === category) }));

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
      {groups
        .filter((group) => group.kinds.length > 0)
        .map(({ category, kinds }) => (
          <Fragment key={category}>
            <div role="row" className="border-t border-kumo-hairline pt-4 pb-1 text-sm font-medium text-kumo-subtle">
              <span role="rowheader">{t(`category${category}`)}</span>
            </div>
            {kinds.map((kind) => (
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
                        checked={cell(kind, channel)?.on ?? false}
                        disabled={cell(kind, channel)?.mutable === false}
                        onCheckedChange={(checked: boolean) => set.mutate({ kind, channel, on: checked })}
                      />
                    )}
                  </span>
                ))}
              </div>
            ))}
          </Fragment>
        ))}
    </div>
  );
}
