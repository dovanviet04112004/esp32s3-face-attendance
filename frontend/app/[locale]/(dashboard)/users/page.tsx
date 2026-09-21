"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useFormatter, useTranslations } from "next-intl";
import { useState, type FormEvent } from "react";

import { DataTable, type Column } from "@/components/tables/data-table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Sheet } from "@/components/ui/sheet";
import { api } from "@/lib/api";
import { useSession, type Role } from "@/lib/auth";
import { useFault } from "@/lib/fault";

// The three CreateUserDto accepts. An account for a PAYROLL or MANAGER
// employee comes from provisioning, which reads the role off their record.
const SETTABLE = ["ADMIN", "HR", "VIEWER"] as const;

type Settable = (typeof SETTABLE)[number];

interface Account {
  id: string;
  email: string;
  role: Role;
  createdAt: string;
  updatedAt: string;
}

const PAGE = 50;

export default function UsersPage() {
  const t = useTranslations("users");
  const common = useTranslations("common");
  const roleName = useTranslations("roles");
  // Closing an account locks somebody out, so the second click is the answer.
  const [dropping, setDropping] = useState<string | null>(null);
  const format = useFormatter();
  const cache = useQueryClient();
  const faultOf = useFault();
  const me = useSession((s) => s.role);

  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Account | null>(null);
  const [fault, setFault] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState<string | null>(null);
  const [role, setRole] = useState<Settable>("VIEWER");

  const rows = useQuery({
    queryKey: ["users"],
    queryFn: async () =>
      (await api.get<{ rows: Account[]; total: number }>(`/users?take=${PAGE}`)).data,
  });

  function done(): void {
    setAdding(false);
    setEditing(null);
    setEmail("");
    void cache.invalidateQueries({ queryKey: ["users"] });
  }

  const add = useMutation({
    mutationFn: () => api.post("/users", { email, role }),
    onSuccess: done,
    onError: (fell: unknown) => setFault(faultOf(fell)),
  });

  const change = useMutation({
    mutationFn: (one: Account) => api.patch(`/users/${one.id}`, { role }),
    onSuccess: done,
    onError: (fell: unknown) => setFault(faultOf(fell)),
  });

  const reinvite = useMutation({
    mutationFn: (one: Account) => api.post(`/users/${one.id}/invite`, {}),
    onSuccess: (unused, one) => {
      setFault(null);
      setSent(one.email);
    },
    onError: (fell: unknown) => setFault(faultOf(fell)),
  });

  const remove = useMutation({
    mutationFn: (one: Account) => api.delete(`/users/${one.id}`),
    onSuccess: () => void cache.invalidateQueries({ queryKey: ["users"] }),
    onError: (fell: unknown) => setFault(faultOf(fell)),
  });

  function submit(event: FormEvent): void {
    event.preventDefault();
    setFault(null);
    add.mutate();
  }

  const columns: Column<Account>[] = [
    {
      id: "email",
      header: t("email"),
      sticky: true,
      sortBy: (row) => row.email,
      cell: (row) => row.email,
    },
    {
      id: "role",
      header: t("role"),
      sortBy: (row) => roleName(row.role),
      cell: (row) => roleName(row.role),
    },
    {
      id: "createdAt",
      header: t("createdAt"),
      sortBy: (row) => row.createdAt,
      cell: (row) => format.dateTime(new Date(row.createdAt), "day"),
    },
    {
      id: "act",
      header: t("act"),
      cell: (row) => (
        <span className="flex flex-wrap gap-1">
          <Button
            type="button"
            tone="quiet"
            size="sm"
            onClick={() => {
              setFault(null);
              setRole(
                (SETTABLE as readonly string[]).includes(row.role)
                  ? (row.role as Settable)
                  : "VIEWER",
              );
              setEditing(row);
            }}
          >
            {t("changeRole")}
          </Button>
          <Button
            type="button"
            tone="quiet"
            size="sm"
            disabled={reinvite.isPending && reinvite.variables?.id === row.id}
            onClick={() => reinvite.mutate(row)}
          >
            {reinvite.isPending && reinvite.variables?.id === row.id
              ? common("saving")
              : t("resend")}
          </Button>
          <Button
            type="button"
            tone={dropping === row.id ? "danger" : "quiet"}
            size="sm"
            disabled={remove.isPending && remove.variables?.id === row.id}
            onClick={() => {
              setFault(null);
              if (dropping === row.id) {
                remove.mutate(row);
                return;
              }
              setDropping(row.id);
            }}
            onBlur={() => setDropping(null)}
          >
            {dropping === row.id ? common("sure") : t("remove")}
          </Button>
        </span>
      ),
    },
  ];

  if (me !== "ADMIN") {
    return <p className="text-sm text-(--color-muted)">{t("adminOnly")}</p>;
  }

  return (
    <section>
      <h1 className="text-lg font-semibold">{t("title")}</h1>
      <p className="mt-1 mb-4 text-sm text-(--color-muted)">{t("lead")}</p>

      {sent ? (
        <p role="status" className="mb-3 text-sm text-(--color-ok)">
          {t("resent", { email: sent })}
        </p>
      ) : null}

      <Button
        type="button"
        className="mb-3"
        onClick={() => {
          setFault(null);
          setAdding(true);
        }}
      >
        {t("add")}
      </Button>

      {fault ? (
        <p role="alert" className="mb-3 text-sm text-(--color-danger)">
          {fault}
        </p>
      ) : null}

      <DataTable
        id="users"
        columns={columns}
        rows={rows.data?.rows}
        keyOf={(row) => row.id}
        pending={rows.isPending}
        failed={rows.isError}
        onRetry={() => rows.refetch()}
      />

      <Sheet
        open={adding}
        onClose={() => setAdding(false)}
        title={t("add")}
        closeLabel={common("close")}
      >
        <form onSubmit={submit}>
          <label className="block text-sm font-medium" htmlFor="userEmail">
            {t("email")}
          </label>
          <Input
            id="userEmail"
            type="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className="mt-1"
          />

          <p className="mt-2 text-sm text-(--color-muted)">{t("inviteLead")}</p>

          <label className="mt-4 block text-sm font-medium" htmlFor="userRole">
            {t("role")}
          </label>
          <Select
            id="userRole"
            value={role}
            onChange={(event) => setRole(event.target.value as Settable)}
            className="mt-1"
          >
            {SETTABLE.map((one) => (
              <option key={one} value={one}>
                {roleName(one)}
              </option>
            ))}
          </Select>
          <p className="mt-1 text-xs text-(--color-muted)">{t("roleHint")}</p>

          {fault ? (
            <p role="alert" className="mt-3 text-sm text-(--color-danger)">
              {fault}
            </p>
          ) : null}
          <Button type="submit" disabled={add.isPending} className="mt-4">
            {add.isPending ? common("saving") : common("save")}
          </Button>
        </form>
      </Sheet>

      <Sheet
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing ? `${editing.email} · ${t("changeRole")}` : t("changeRole")}
        closeLabel={common("close")}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            setFault(null);
            if (editing) {
              change.mutate(editing);
            }
          }}
        >
          <label className="block text-sm font-medium" htmlFor="editRole">
            {t("role")}
          </label>
          <Select
            id="editRole"
            value={role}
            onChange={(event) => setRole(event.target.value as Settable)}
            className="mt-1"
          >
            {SETTABLE.map((one) => (
              <option key={one} value={one}>
                {roleName(one)}
              </option>
            ))}
          </Select>
          <p className="mt-1 text-xs text-(--color-muted)">{t("roleHint")}</p>

          {fault ? (
            <p role="alert" className="mt-3 text-sm text-(--color-danger)">
              {fault}
            </p>
          ) : null}
          <Button type="submit" disabled={change.isPending} className="mt-4">
            {change.isPending ? common("saving") : common("save")}
          </Button>
        </form>
      </Sheet>
    </section>
  );
}
