"use client";

import { Banner, Button, Input, LayerDialog, Select } from "@cloudflare/kumo";
import { EnvelopeSimpleIcon, LockIcon, PlusIcon, TrashIcon, UserSwitchIcon } from "@phosphor-icons/react";
import { useInfiniteQuery, useMutation, useQueries, useQueryClient } from "@tanstack/react-query";
import { useFormatter, useTranslations } from "next-intl";
import { useState } from "react";

import { DataTable, type Column } from "@/components/tables/data-table";
import { FilterBar, useSettled } from "@/components/ui/filter-bar";
import { useNotify } from "@/components/ui/notify";
import { AsideCard, PageHeader, PageLayout, StatList } from "@/components/ui/page";
import { StatePill } from "@/components/ui/pill";
import { api } from "@/lib/api";
import { useSession, type Role } from "@/lib/auth";
import { useFault } from "@/lib/fault";

// The three CreateUserDto accepts. An account for a PAYROLL or MANAGER
// employee comes from provisioning, which reads the role off their record.
const SETTABLE = ["ADMIN", "HR", "VIEWER"] as const;

type Settable = (typeof SETTABLE)[number];

const ROLES: Role[] = ["ADMIN", "HR", "PAYROLL", "MANAGER", "EMPLOYEE", "VIEWER"];

interface Account {
  id: string;
  email: string;
  role: Role;
  createdAt: string;
  updatedAt: string;
}

interface AccountPage {
  rows: Account[];
  total: number;
  totalIsExact?: boolean;
}

const kPage = 200;

function settable(role: Role): Settable {
  return (SETTABLE as readonly string[]).includes(role) ? (role as Settable) : "VIEWER";
}

export default function UsersPage() {
  const t = useTranslations("users");
  const common = useTranslations("common");
  const roleName = useTranslations("roles");
  const format = useFormatter();
  const cache = useQueryClient();
  const notify = useNotify();
  const faultOf = useFault();
  const me = useSession((s) => s.role);
  const isAdmin = me === "ADMIN";

  const [typed, setTyped] = useState("");
  const search = useSettled(typed.trim().toLowerCase());
  const [roleShown, setRoleShown] = useState<Role | "">("");
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Account | null>(null);
  const [dropping, setDropping] = useState<Account | null>(null);
  const [fault, setFault] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Settable>("VIEWER");

  const accounts = useInfiniteQuery({
    queryKey: ["users", roleShown],
    enabled: isAdmin,
    initialPageParam: 0,
    queryFn: async ({ pageParam }) =>
      (await api.get<AccountPage>(`/users?take=${kPage}&skip=${pageParam}${roleShown ? `&role=${roleShown}` : ""}`)).data,
    getNextPageParam: (last, all) => {
      const seen = all.reduce((sum, one) => sum + one.rows.length, 0);
      return last.rows.length === kPage && seen < last.total ? seen : undefined;
    },
  });

  // One row asked per role: the total of each answer is that role's count.
  const perRole = useQueries({
    queries: ROLES.map((one) => ({
      queryKey: ["users", "count", one],
      enabled: isAdmin,
      queryFn: async () => (await api.get<AccountPage>(`/users?take=1&role=${one}`)).data.total,
    })),
  });

  function after(message: string): void {
    notify.done(message);
    void cache.invalidateQueries({ queryKey: ["users"] });
  }

  const add = useMutation({
    mutationFn: () => api.post("/users", { email, role }),
    onSuccess: () => {
      setAdding(false);
      after(t("invited", { email }));
    },
    onError: (fell: unknown) => setFault(faultOf(fell)),
  });

  const change = useMutation({
    mutationFn: (one: Account) => api.patch(`/users/${one.id}`, { role }),
    onSuccess: (_, one) => {
      setEditing(null);
      after(t("roleChanged", { email: one.email, role: roleName(role) }));
    },
    onError: (fell: unknown) => setFault(faultOf(fell)),
  });

  const reinvite = useMutation({
    mutationFn: (one: Account) => api.post(`/users/${one.id}/invite`, {}),
    onSuccess: (_, one) => notify.done(t("resent", { email: one.email })),
    onError: notify.failed,
  });

  const remove = useMutation({
    mutationFn: (one: Account) => api.delete(`/users/${one.id}`),
    onSuccess: (_, one) => {
      setDropping(null);
      after(t("removed", { email: one.email }));
    },
    onError: (fell: unknown) => setFault(faultOf(fell)),
  });

  function startEditing(one: Account): void {
    setFault(null);
    setRole(settable(one.role));
    setEditing(one);
  }

  if (me !== null && !isAdmin) {
    return (
      <>
        <PageHeader title={t("title")} />
        <Banner variant="secondary" icon={<LockIcon weight="fill" />} description={t("adminOnly")} />
      </>
    );
  }

  const loaded = accounts.data?.pages.flatMap((one) => one.rows) ?? [];
  const first = accounts.data?.pages[0];
  const countOf = (one: Role) => perRole[ROLES.indexOf(one)]?.data;
  const everyone = perRole.every((one) => one.isSuccess)
    ? perRole.reduce((sum, one) => sum + (one.data ?? 0), 0)
    : undefined;
  const shown = loaded.filter((row) => search === "" || row.email.toLowerCase().includes(search));

  const columns: Column<Account>[] = [
    {
      id: "email",
      header: t("email"),
      sticky: true,
      sortBy: (row) => row.email,
      cell: (row) => <span className="break-all">{row.email}</span>,
    },
    {
      id: "role",
      header: t("role"),
      sortBy: (row) => roleName(row.role),
      cell: (row) => <StatePill>{roleName(row.role)}</StatePill>,
    },
    {
      id: "createdAt",
      header: t("createdAt"),
      sortBy: (row) => row.createdAt,
      cell: (row) => <span className="tabular-nums">{format.dateTime(new Date(row.createdAt), "day")}</span>,
    },
  ];

  return (
    <>
      <PageHeader
        title={t("title")}
        description={t("lead")}
        actions={
          <Button
            variant="primary"
            icon={PlusIcon}
            onClick={() => {
              setFault(null);
              setEmail("");
              setRole("VIEWER");
              setAdding(true);
            }}
          >
            {t("add")}
          </Button>
        }
      />

      <PageLayout
        aside={
          <AsideCard title={t("byRole")}>
            <StatList
              stats={[
                ...ROLES.filter((one) => (countOf(one) ?? 0) > 0 || roleShown === one).map((one) => ({
                  key: one,
                  label: roleName(one),
                  value: countOf(one) ?? common("empty"),
                  active: roleShown === one,
                  onPick: () => setRoleShown(one),
                })),
                {
                  key: "all",
                  label: common("all"),
                  value: everyone ?? common("empty"),
                  active: roleShown === "",
                  onPick: () => setRoleShown(""),
                },
              ]}
            />
          </AsideCard>
        }
        extra={
          <AsideCard title={common("goodToKnow")}>
            <p className="text-pretty text-kumo-subtle">{t("roleHint")}</p>
          </AsideCard>
        }
      >
        <FilterBar
          search={{ value: typed, onChange: setTyped, placeholder: t("searchHint") }}
          filters={[
            {
              key: "role",
              label: t("role"),
              value: roleShown,
              onChange: (next) => setRoleShown(next as Role | ""),
              items: { "": common("all"), ...Object.fromEntries(ROLES.map((one) => [one, roleName(one)])) },
            },
          ]}
        />
        <DataTable
          id="users"
          cardLead="email"
          columns={columns}
          rows={shown}
          keyOf={(row) => row.id}
          pending={accounts.isPending}
          failed={accounts.isError}
          onRetry={() => void accounts.refetch()}
          onRowClick={startEditing}
          rowActions={(row) => [
            { key: "role", label: t("changeRole"), icon: UserSwitchIcon, onSelect: () => startEditing(row) },
            {
              key: "invite",
              label: t("resend"),
              icon: EnvelopeSimpleIcon,
              disabled: reinvite.isPending && reinvite.variables?.id === row.id,
              onSelect: () => reinvite.mutate(row),
            },
            {
              key: "remove",
              label: t("remove"),
              icon: TrashIcon,
              danger: true,
              onSelect: () => {
                setFault(null);
                setDropping(row);
              },
            },
          ]}
          empty={search || roleShown ? t("noMatch") : undefined}
          paging={
            first
              ? {
                  shown: loaded.length,
                  total: first.total,
                  exact: first.totalIsExact,
                  onMore: accounts.hasNextPage ? () => void accounts.fetchNextPage() : undefined,
                  loading: accounts.isFetchingNextPage,
                }
              : undefined
          }
        />
      </PageLayout>

      <LayerDialog.Root open={adding} onOpenChange={setAdding} dismissDisabled={add.isPending}>
        <LayerDialog.Content closeLabel={common("close")}>
          <LayerDialog.Title>{t("add")}</LayerDialog.Title>
          <LayerDialog.Description>{t("inviteLead")}</LayerDialog.Description>
          <LayerDialog.Body>
            <div className="flex flex-col gap-4">
              <Input label={t("email")} type="email" required value={email} onChange={(event) => setEmail(event.target.value)} />
              <Select
                label={t("role")}
                hideLabel={false}
                value={role}
                onValueChange={(next) => setRole(settable(String(next ?? "VIEWER") as Role))}
                items={Object.fromEntries(SETTABLE.map((one) => [one, roleName(one)]))}
                description={t("roleHint")}
                className="w-full"
              />
              {fault ? <p className="text-kumo-danger">{fault}</p> : null}
            </div>
          </LayerDialog.Body>
          <LayerDialog.Actions dismissLabel={common("cancel")}>
            <LayerDialog.Actions.Primary loading={add.isPending} disabled={!email.includes("@")} onClick={() => add.mutate()}>
              {t("sendInvite")}
            </LayerDialog.Actions.Primary>
          </LayerDialog.Actions>
        </LayerDialog.Content>
      </LayerDialog.Root>

      <LayerDialog.Root open={editing !== null} onOpenChange={(next) => !next && setEditing(null)} dismissDisabled={change.isPending}>
        <LayerDialog.Content closeLabel={common("close")}>
          <LayerDialog.Title>{t("changeRole")}</LayerDialog.Title>
          <LayerDialog.Description>
            {editing ? t("changeRoleLead", { email: editing.email, role: roleName(editing.role) }) : ""}
          </LayerDialog.Description>
          <LayerDialog.Body>
            <div className="flex flex-col gap-4">
              <Select
                label={t("role")}
                hideLabel={false}
                value={role}
                onValueChange={(next) => setRole(settable(String(next ?? "VIEWER") as Role))}
                items={Object.fromEntries(SETTABLE.map((one) => [one, roleName(one)]))}
                description={t("roleHint")}
                className="w-full"
              />
              {fault ? <p className="text-kumo-danger">{fault}</p> : null}
            </div>
          </LayerDialog.Body>
          <LayerDialog.Actions dismissLabel={common("cancel")}>
            <LayerDialog.Actions.Primary
              loading={change.isPending}
              disabled={editing?.role === role}
              onClick={() => editing && change.mutate(editing)}
            >
              {common("save")}
            </LayerDialog.Actions.Primary>
          </LayerDialog.Actions>
        </LayerDialog.Content>
      </LayerDialog.Root>

      <LayerDialog.Alert open={dropping !== null} onOpenChange={(next) => !next && setDropping(null)} dismissDisabled={remove.isPending}>
        <LayerDialog.Content closeLabel={common("close")}>
          <LayerDialog.Title>{t("removeTitle")}</LayerDialog.Title>
          <LayerDialog.Description>
            {dropping ? t("removeWarn", { email: dropping.email }) : ""}
          </LayerDialog.Description>
          <LayerDialog.Body>
            <p className="text-kumo-subtle">{dropping ? roleName(dropping.role) : ""}</p>
            {fault ? <p className="mt-3 text-kumo-danger">{fault}</p> : null}
          </LayerDialog.Body>
          <LayerDialog.Actions dismissLabel={common("cancel")}>
            <LayerDialog.Actions.Primary
              variant="destructive"
              loading={remove.isPending}
              onClick={() => dropping && remove.mutate(dropping)}
            >
              {t("removeGo")}
            </LayerDialog.Actions.Primary>
          </LayerDialog.Actions>
        </LayerDialog.Content>
      </LayerDialog.Alert>
    </>
  );
}
