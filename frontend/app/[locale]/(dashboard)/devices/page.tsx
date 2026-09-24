"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useFormatter, useTranslations } from "next-intl";
import { useState, type FormEvent } from "react";

import { DataTable, type Column } from "@/components/tables/data-table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet } from "@/components/ui/sheet";
import { Link } from "@/i18n/navigation";
import { api } from "@/lib/api";
import { useSession } from "@/lib/auth";
import { useFault } from "@/lib/fault";

interface Release {
  releaseId: string;
  target: "FIRMWARE" | "MODELS";
  version: string;
  sizeBytes: number;
  createdAt: string;
  available: boolean;
}

/** The newest release of one kind and the approved kiosks behind it; the server owns the rule. */
interface FleetUpdate {
  release: Release;
  behind: string[];
}

interface Device {
  id: string;
  name: string | null;
  location: string | null;
  status: "PENDING" | "APPROVED" | "REVOKED";
  fwVersion: string | null;
  rosterVersion: number;
  online: boolean;
}

/** Approval needs the code on the kiosk's own screen, so only whoever stands at it can
 *  let it in (KEHOACH 7.3).
 */
function Approve({ id }: { id: string }) {
  const t = useTranslations("devices");
  const cache = useQueryClient();
  const faultOf = useFault();
  const [code, setCode] = useState("");
  const [fault, setFault] = useState<string | null>(null);
  const approve = useMutation({
    mutationFn: () => api.post(`/devices/${id}/approve`, { claimCode: code }),
    onSuccess: () => void cache.invalidateQueries({ queryKey: ["devices"] }),
    onError: (fell: unknown) => setFault(faultOf(fell)),
  });

  function submit(event: FormEvent): void {
    event.preventDefault();
    setFault(null);
    approve.mutate();
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <Input
          aria-label={t("claimLabel")}
          inputMode="numeric"
          autoComplete="off"
          required
          placeholder={t("claimPlaceholder")}
          value={code}
          onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
          className="w-24 font-mono tabular-nums"
        />
        <Button
          size="sm"
          tone="quiet"
          type="submit"
          disabled={approve.isPending || code.length !== 6}
        >
          {approve.isPending ? t("approving") : t("approve")}
        </Button>
      </div>
      {fault ? (
        <p role="alert" className="text-xs text-(--color-danger)">
          {fault}
        </p>
      ) : null}
    </form>
  );
}

export default function DevicesPage() {
  const t = useTranslations("devices");
  const common = useTranslations("common");
  const format = useFormatter();
  const role = useSession((s) => s.role);
  const cache = useQueryClient();
  const faultOf = useFault();
  const [asking, setAsking] = useState<FleetUpdate | null>(null);
  const [sent, setSent] = useState<{ offered: number; failed: number } | null>(null);
  const [fault, setFault] = useState<string | null>(null);
  const devices = useQuery({
    queryKey: ["devices"],
    queryFn: async () => (await api.get<{ rows: Device[]; total: number }>("/devices")).data,
  });
  const releases = useQuery({
    queryKey: ["releases"],
    enabled: role === "ADMIN",
    queryFn: async () => (await api.get<Release[]>("/releases")).data,
  });
  const fleet = useQuery({
    queryKey: ["releases", "fleet"],
    enabled: role === "ADMIN",
    queryFn: async () => (await api.get<FleetUpdate[]>("/releases/fleet")).data,
  });

  const updateAll = useMutation({
    mutationFn: async (releaseId: string) =>
      (await api.post<{ offered: string[]; failed: string[] }>(`/releases/${releaseId}/offer`, {})).data,
    onSuccess: (done) => {
      setAsking(null);
      setSent({ offered: done.offered.length, failed: done.failed.length });
      void cache.invalidateQueries({ queryKey: ["releases"] });
    },
    onError: (fell: unknown) => {
      setAsking(null);
      setFault(faultOf(fell));
    },
  });

  const updatesFor = (deviceId: string): FleetUpdate[] =>
    (fleet.data ?? []).filter((update) => update.behind.includes(deviceId));

  const columns: Column<Device>[] = [
    {
      id: "device",
      header: t("device"),
      sticky: true,
      sortBy: (row) => row.name ?? row.id,
      cell: (row) => (
        <Link href={`/devices/${row.id}`} className="block hover:underline">
          <p>{row.name ?? t("unnamed")}</p>
          <p className="font-mono text-xs text-(--color-muted)">{row.id}</p>
        </Link>
      ),
    },
    {
      id: "status",
      header: t("status"),
      cell: (row) =>
        row.status === "PENDING" && role === "ADMIN" ? (
          <Approve id={row.id} />
        ) : (
          <span className="text-(--color-muted)">{t(`status${row.status}`)}</span>
        ),
    },
    {
      id: "location",
      header: t("location"),
      sortBy: (row) => row.location ?? "",
      cell: (row) => row.location ?? common("empty"),
    },
    {
      id: "firmware",
      header: t("firmware"),
      cell: (row) => (
        <div className="flex flex-wrap items-center gap-2">
          <span>{row.fwVersion ?? common("empty")}</span>
          {updatesFor(row.id).map((update) => (
            <Link
              key={update.release.releaseId}
              href={`/devices/${row.id}`}
              className="rounded-full border border-(--color-accent) px-2 py-0.5 text-xs text-(--color-accent) hover:underline"
            >
              {t("updateBadge", { target: t(`target${update.release.target}`), version: update.release.version })}
            </Link>
          ))}
        </div>
      ),
    },
    {
      id: "roster",
      header: t("roster"),
      numeric: true,
      sortBy: (row) => row.rosterVersion,
      cell: (row) => row.rosterVersion,
    },
    {
      id: "link",
      header: t("link"),
      sortBy: (row) => (row.online ? 1 : 0),
      cell: (row) => (
        <span className={row.online ? "text-(--color-ok)" : "text-(--color-muted)"}>
          {row.online ? t("online") : t("offline")}
        </span>
      ),
    },
  ];

  return (
    <section>
      <h1 className="text-lg font-semibold">{t("title")}</h1>
      <p className="mt-1 mb-6 text-sm text-(--color-muted)">{t("lead")}</p>
      <DataTable
        id="devices"
        columns={columns}
        rows={devices.data?.rows}
        keyOf={(row) => row.id}
        pending={devices.isPending}
        failed={devices.isError}
        onRetry={() => devices.refetch()}
      />

      {role === "ADMIN" ? (
        <section className="mt-8 max-w-2xl rounded-xl border border-(--color-line) bg-(--color-surface) p-4">
          <h2 className="text-sm font-medium">{t("releasesTitle")}</h2>
          <p className="mt-1 text-sm text-(--color-muted)">{t("releasesLead")}</p>

          <ul className="mt-3 flex flex-col">
            {(fleet.data ?? []).map((update) => (
              <li
                key={update.release.releaseId}
                className="flex flex-wrap items-center gap-3 border-b border-(--color-line) py-2 text-sm last:border-0"
              >
                <span className="font-medium">{t(`target${update.release.target}`)}</span>
                <span className="font-mono text-xs">{update.release.version}</span>
                <span className="text-xs text-(--color-muted)">
                  {t("releaseBehind", { count: update.behind.length })}
                </span>
                <Button
                  size="sm"
                  className="ms-auto"
                  disabled={update.behind.length === 0 || updateAll.isPending}
                  onClick={() => {
                    setFault(null);
                    setSent(null);
                    setAsking(update);
                  }}
                >
                  {t("releaseUpdateAll", { count: update.behind.length })}
                </Button>
              </li>
            ))}
            {fleet.isSuccess && (fleet.data ?? []).length === 0 ? (
              <li className="py-2 text-sm text-(--color-muted)">{t("releasesEmpty")}</li>
            ) : null}
          </ul>

          {sent ? (
            <p role="status" className="mt-3 text-sm text-(--color-ok)">
              {t("releaseUpdateAllDone", sent)}
            </p>
          ) : null}
          {fault ? (
            <p role="alert" className="mt-3 text-sm text-(--color-danger)">
              {fault}
            </p>
          ) : null}

          {(releases.data ?? []).length > 0 ? (
            <details className="mt-4">
              <summary className="cursor-pointer text-xs text-(--color-muted)">{t("releasesHistory")}</summary>
              <ul className="mt-2 flex flex-col">
                {(releases.data ?? []).map((one) => (
                  <li key={one.releaseId} className="flex flex-wrap items-center gap-3 py-1 text-xs">
                    <span>{t(`target${one.target}`)}</span>
                    <span className="font-mono">{one.version}</span>
                    <span className="text-(--color-muted)">{format.dateTime(new Date(one.createdAt), "medium")}</span>
                    <span className="ms-auto text-(--color-muted)">
                      {one.available ? t("releaseSize", { kb: Math.round(one.sizeBytes / 1024) }) : t("releaseCleared")}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </section>
      ) : null}

      <Sheet
        open={asking !== null}
        onClose={() => setAsking(null)}
        title={t("releaseUpdateAllTitle")}
        closeLabel={common("close")}
      >
        {asking ? (
          <>
            <p className="text-sm text-(--color-muted)">
              {t("releaseUpdateAllAsk", {
                count: asking.behind.length,
                target: t(`target${asking.release.target}`),
                version: asking.release.version,
              })}
            </p>
            <Button
              type="button"
              className="mt-4"
              disabled={updateAll.isPending}
              onClick={() => updateAll.mutate(asking.release.releaseId)}
            >
              {updateAll.isPending ? common("saving") : t("releaseUpdateAll", { count: asking.behind.length })}
            </Button>
          </>
        ) : null}
      </Sheet>
    </section>
  );
}
