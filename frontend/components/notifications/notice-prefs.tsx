"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";

import { Checkbox } from "@/components/ui/checkbox";
import { api } from "@/lib/api";
import type { NoticeKind } from "./notice-list";

type Channel = "IN_APP" | "PUSH" | "EMAIL";

interface Preference {
  kind: NoticeKind;
  channel: Channel;
  on: boolean;
}

const KIND_KEY: Record<
  NoticeKind,
  "kindREQUEST_WAITING" | "kindPAYSLIP_ISSUED" | "kindCONTRACT_ENDING" | "kindREQUEST_DECIDED_true"
> = {
  REQUEST_DECIDED: "kindREQUEST_DECIDED_true",
  REQUEST_WAITING: "kindREQUEST_WAITING",
  PAYSLIP_ISSUED: "kindPAYSLIP_ISSUED",
  CONTRACT_ENDING: "kindCONTRACT_ENDING",
};

const CHANNEL_KEY: Record<Channel, "channelIN_APP" | "channelPUSH" | "channelEMAIL"> = {
  IN_APP: "channelIN_APP",
  PUSH: "channelPUSH",
  EMAIL: "channelEMAIL",
};

const KINDS: NoticeKind[] = [
  "REQUEST_DECIDED",
  "REQUEST_WAITING",
  "PAYSLIP_ISSUED",
  "CONTRACT_ENDING",
];
const CHANNELS: Channel[] = ["IN_APP", "PUSH", "EMAIL"];

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
                {kind === "CONTRACT_ENDING" ? t(KIND_KEY[kind], { count: 30 }) : t(KIND_KEY[kind])}
              </td>
              {CHANNELS.map((channel) => (
                <td key={channel} className="px-3 py-2">
                  <Checkbox
                    className="min-h-0"
                    aria-label={`${kind} ${channel}`}
                    checked={on(kind, channel)}
                    disabled={set.isPending}
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
