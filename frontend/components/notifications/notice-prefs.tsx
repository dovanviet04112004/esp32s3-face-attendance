"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";

import { Checkbox } from "@/components/ui/checkbox";
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

export function NoticePreferences() {
  const t = useTranslations("notices");
  const cache = useQueryClient();

  const prefs = useQuery({
    queryKey: ["notifications", "preferences"],
    queryFn: async () => (await api.get<Preference[]>("/notifications/preferences")).data,
  });

  const set = useMutation({
    mutationFn: (body: Preference) => api.post("/notifications/preferences", body),
    onSuccess: () => void cache.invalidateQueries({ queryKey: ["notifications", "preferences"] }),
  });

  function on(kind: NoticeKind, channel: Channel): boolean {
    return prefs.data?.find((row) => row.kind === kind && row.channel === channel)?.on ?? false;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-(--color-muted)">
            <th className="py-2 font-medium" />
            {CHANNELS.map((channel) => (
              <th key={channel} className="px-3 py-2 font-medium">
                {t(CHANNEL_KEY[channel])}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {KINDS.map((kind) => (
            <tr key={kind} className="border-t border-(--color-line)">
              <td className="py-2 pe-3">
                {kind === "CONTRACT_ENDING" || kind === "REQUEST_STALLED"
                  ? t(KIND_KEY[kind], { count: kind === "CONTRACT_ENDING" ? 30 : 7 })
                  : t(KIND_KEY[kind])}
              </td>
              {CHANNELS.map((channel) => (
                <td key={channel} className="px-3 py-2">
                  <Checkbox
                    className="min-h-0"
                    aria-label={`${t(KIND_KEY[kind], { count: 0 })} · ${t(CHANNEL_KEY[channel])}`}
                    checked={on(kind, channel)}
                    disabled={
                      set.isPending &&
                      set.variables?.kind === kind &&
                      set.variables?.channel === channel
                    }
                    onChange={(event) =>
                      set.mutate({ kind, channel, on: event.target.checked })
                    }
                    label=""
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
