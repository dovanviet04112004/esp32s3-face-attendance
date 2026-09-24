"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState, type FormEvent } from "react";

import { DataTable, type Column } from "@/components/tables/data-table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Link } from "@/i18n/navigation";
import { api } from "@/lib/api";
import { useSession } from "@/lib/auth";
import { useFault } from "@/lib/fault";

const TARGETS = ["FIRMWARE", "MODELS", "ASSETS"] as const;

type Target = (typeof TARGETS)[number];

interface Release {
  releaseId: string;
  target: Target;
  version: string;
  sizeBytes: number;
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
  const role = useSession((s) => s.role);
  const cache = useQueryClient();
  const faultOf = useFault();
  const [target, setTarget] = useState<Target>("FIRMWARE");
  const [version, setVersion] = useState("");
  const [url, setUrl] = useState("");
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

  const register = useMutation({
    mutationFn: () =>
      api.post("/releases", {
        target,
        version,
        url,
      }),
    onSuccess: () => {
      setUrl("");
      void cache.invalidateQueries({ queryKey: ["releases"] });
    },
    onError: (fell: unknown) => setFault(faultOf(fell)),
  });

  function publish(event: FormEvent): void {
    event.preventDefault();
    setFault(null);
    register.mutate();
  }

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
    { id: "firmware", header: t("firmware"), cell: (row) => row.fwVersion ?? common("empty") },
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
            {(releases.data ?? []).map((one) => (
              <li
                key={one.releaseId}
                className="flex flex-wrap items-center gap-3 border-b border-(--color-line) py-2 text-sm last:border-0"
              >
                <span className="font-medium">{one.target}</span>
                <span className="font-mono text-xs">{one.version}</span>
                <span className="ms-auto text-xs text-(--color-muted)">
                  {t("releaseSize", { kb: Math.round(one.sizeBytes / 1024) })}
                </span>
              </li>
            ))}
            {releases.isSuccess && (releases.data ?? []).length === 0 ? (
              <li className="py-2 text-sm text-(--color-muted)">{t("releasesEmpty")}</li>
            ) : null}
          </ul>

          <form onSubmit={publish} className="mt-4 grid gap-3 sm:grid-cols-2">
            <div>
              <label className="block text-xs text-(--color-muted)" htmlFor="relTarget">
                {t("releaseTarget")}
              </label>
              <Select
                id="relTarget"
                value={target}
                onChange={(event) => setTarget(event.target.value as Target)}
                className="mt-1"
              >
                {TARGETS.map((one) => (
                  <option key={one} value={one}>
                    {one}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <label className="block text-xs text-(--color-muted)" htmlFor="relVersion">
                {t("releaseVersion")}
              </label>
              <Input
                id="relVersion"
                required
                placeholder="0.9.2"
                value={version}
                onChange={(event) => setVersion(event.target.value)}
                className="mt-1"
              />
            </div>
            <div className="sm:col-span-2">
              <label className="block text-xs text-(--color-muted)" htmlFor="relUrl">
                {t("releaseUrl")}
              </label>
              <Input
                id="relUrl"
                required
                type="url"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                className="mt-1"
              />
            </div>
            <p className="text-xs text-(--color-muted) sm:col-span-2">{t("releaseMeasured")}</p>
            <div className="flex items-end">
              <Button type="submit" disabled={register.isPending}>
                {register.isPending ? common("saving") : t("releaseAdd")}
              </Button>
            </div>
          </form>

          {fault ? (
            <p role="alert" className="mt-3 text-sm text-(--color-danger)">
              {fault}
            </p>
          ) : null}
        </section>
      ) : null}
    </section>
  );
}
