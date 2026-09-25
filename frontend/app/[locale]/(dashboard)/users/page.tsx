"use client";

import { Banner, Button, Input, LayerDialog, Select } from "@cloudflare/kumo";
import {
  EnvelopeSimpleIcon,
  LockIcon,
  LockOpenIcon,
  PlusIcon,
  TrashIcon,
  UserGearIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useFormatter, useTranslations } from "next-intl";
import { Suspense, useEffect, useState } from "react";

import { DataTable, PersonCell, type Column, type RowAction } from "@/components/tables/data-table";
import { FilterBar, useSettled } from "@/components/ui/filter-bar";
import { useNotify } from "@/components/ui/notify";
import { PageHeader, PageLayout } from "@/components/ui/page";
import { PersonPicker, type Person } from "@/components/ui/person-picker";
import { StatePill, type Tone } from "@/components/ui/pill";
import { api } from "@/lib/api";
import { useSession, type Role } from "@/lib/auth";
import { useFault } from "@/lib/fault";
import { useUrlState } from "@/lib/url-state";

const ROLES: Role[] = ["ADMIN", "HR", "PAYROLL", "MANAGER", "EMPLOYEE", "VIEWER"];
// The roles that read or decide as one person in the company (KEHOACH 9.4).
const NEEDS_PERSON: ReadonlySet<Role> = new Set<Role>(["EMPLOYEE", "MANAGER", "PAYROLL"]);
const STATUSES = ["active", "pending", "locked"] as const;
const kPage = 50;
const kEmailMax = 128;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Status = (typeof STATUSES)[number];

const TONE: Record<Status, Tone> = { active: "good", pending: "waiting", locked: "bad" };

interface Account {
  id: string;
  email: string;
  role: Role;
  active: boolean;
  pending: boolean;
  lastSeenAt: string | null;
  createdAt: string;
  employee: { id: number; code: string; fullName: string; department: { id: string; name: string } | null } | null;
}

interface AccountPage {
  rows: Account[];
  total: number;
  totalIsExact?: boolean;
  next: string | null;
}

interface Counts {
  byRole: Record<Role, number>;
  byStatus: Record<Status, number>;
}

interface Department {
  id: string;
  name: string;
}

interface Draft {
  account: Account | null;
  email: string;
  role: Role;
  person: Person | null;
}

function statusOf(row: Account): Status {
  if (!row.active) {
    return "locked";
  }
  return row.pending ? "pending" : "active";
}

function queryOf(params: Record<string, string>): string {
  const kept = Object.entries(params).filter(([, value]) => value !== "");
  return kept.length ? `?${new URLSearchParams(kept).toString()}` : "";
}

function Accounts() {
  const t = useTranslations("users");
  const common = useTranslations("common");
  const roleName = useTranslations("roles");
  const format = useFormatter();
  const cache = useQueryClient();
  const notify = useNotify();
  const faultOf = useFault();
  const me = useSession((s) => s.role);
  const isAdmin = me === "ADMIN";

  const [url, setUrl] = useUrlState({ q: "", role: "", departmentId: "", status: "" });
  const [typed, setTyped] = useState(url.q);
  const settled = useSettled(typed.trim());
  useEffect(() => {
    if (settled !== url.q) {
      setUrl({ q: settled });
    }
  }, [settled]); // eslint-disable-line react-hooks/exhaustive-deps
  const filters = { search: url.q, role: url.role, departmentId: url.departmentId, status: url.status };
  const filtering = Object.values(filters).some((value) => value !== "");

  const [draft, setDraft] = useState<Draft | null>(null);
  const [tried, setTried] = useState(false);
  const [fault, setFault] = useState<string | null>(null);
  const [locking, setLocking] = useState<Account | null>(null);
  const [dropping, setDropping] = useState<Account | null>(null);

  const accounts = useInfiniteQuery({
    queryKey: ["users", "list", filters],
    enabled: isAdmin,
    initialPageParam: "",
    queryFn: async ({ pageParam }) =>
      (await api.get<AccountPage>(`/users${queryOf({ ...filters, take: String(kPage), cursor: pageParam })}`)).data,
    getNextPageParam: (last) => last.next ?? undefined,
  });

  const counts = useQuery({
    queryKey: ["users", "counts", filters],
    enabled: isAdmin,
    queryFn: async () => (await api.get<Counts>(`/users/counts${queryOf(filters)}`)).data,
  });

  const departments = useQuery({
    queryKey: ["departments"],
    enabled: isAdmin,
    queryFn: async () => (await api.get<Department[]>("/departments")).data,
  });

  const self = useQuery({
    queryKey: ["users", "me"],
    enabled: isAdmin,
    queryFn: async () => (await api.get<{ id: string }>("/users/me")).data,
  });

  function done(message: string): void {
    notify.done(message);
    void cache.invalidateQueries({ queryKey: ["users"] });
    void cache.invalidateQueries({ queryKey: ["employees"] });
  }

  const save = useMutation({
    mutationFn: async (held: Draft) => {
      const email = held.email.trim();
      if (!held.account) {
        const body = { email, role: held.role, ...(held.person ? { employeeId: held.person.id } : {}) };
        return (await api.post<Account>("/users", body)).data;
      }
      const was = held.account.employee?.id ?? null;
      const now = held.person?.id ?? null;
      const patch = {
        ...(email !== held.account.email ? { email } : {}),
        ...(held.role !== held.account.role ? { role: held.role } : {}),
        ...(was !== now ? { employeeId: now } : {}),
      };
      return (await api.patch<Account>(`/users/${held.account.id}`, patch)).data;
    },
    onSuccess: (saved, held) => {
      setDraft(null);
      done(t(held.account ? "saved" : "invited", { email: saved.email, role: roleName(saved.role) }));
    },
    onError: (fell: unknown) => setFault(faultOf(fell)),
  });

  const lock = useMutation({
    mutationFn: async ({ one, active }: { one: Account; active: boolean }) =>
      (await api.patch<Account>(`/users/${one.id}`, { active })).data,
    onSuccess: (saved) => {
      setLocking(null);
      done(t(saved.active ? "unlocked" : "locked", { email: saved.email }));
    },
    onError: (fell: unknown, { active }) => (active ? notify.failed(fell) : setFault(faultOf(fell))),
  });

  const resend = useMutation({
    mutationFn: (one: Account) => api.post(`/users/${one.id}/invite`, {}),
    onSuccess: (_, one) => notify.done(t("resent", { email: one.email })),
    onError: notify.failed,
  });

  const remove = useMutation({
    mutationFn: (one: Account) => api.delete(`/users/${one.id}`),
    onSuccess: (_, one) => {
      setDropping(null);
      done(t("removed", { email: one.email }));
    },
    onError: (fell: unknown) => setFault(faultOf(fell)),
  });

  function open(one: Account | null): void {
    setFault(null);
    setTried(false);
    setDraft({
      account: one,
      email: one?.email ?? "",
      role: one?.role ?? "VIEWER",
      person: one?.employee ? { id: one.employee.id, code: one.employee.code, fullName: one.employee.fullName } : null,
    });
  }

  // The address on the record is where the link goes, so picking a person fills it in.
  async function pick(person: Person | null): Promise<void> {
    setDraft((held) => (held ? { ...held, person } : held));
    if (!person) {
      return;
    }
    const record = (await api.get<{ personalEmail: string | null }>(`/employees/${person.id}`)).data;
    setDraft((held) => (held && held.email === "" && record.personalEmail ? { ...held, email: record.personalEmail } : held));
  }

  function submit(held: Draft): void {
    setTried(true);
    if (!EMAIL.test(held.email.trim()) || (NEEDS_PERSON.has(held.role) && !held.person)) {
      return;
    }
    setFault(null);
    save.mutate(held);
  }

  if (me !== null && !isAdmin) {
    return (
      <>
        <PageHeader title={t("title")} />
        <Banner variant="secondary" icon={<LockIcon weight="fill" />} description={t("adminOnly")} />
      </>
    );
  }

  const loaded = accounts.data?.pages.flatMap((one) => one.rows);
  const first = accounts.data?.pages[0];
  const needsPerson = draft !== null && NEEDS_PERSON.has(draft.role);
  const emailWrong = draft !== null && tried && !EMAIL.test(draft.email.trim());
  const personMissing = tried && needsPerson && draft?.person === null;

  const columns: Column<Account>[] = [
    {
      id: "account",
      header: t("account"),
      cell: (row) => (
        <PersonCell
          name={row.employee?.fullName ?? row.email}
          code={row.employee ? row.email : null}
          href={row.employee ? `/employees/${row.employee.id}` : undefined}
        />
      ),
    },
    {
      id: "department",
      header: t("department"),
      priority: 2,
      truncate: true,
      cell: (row) => row.employee?.department?.name ?? common("empty"),
    },
    { id: "role", header: t("role"), cell: (row) => <StatePill>{roleName(row.role)}</StatePill> },
    {
      id: "status",
      header: t("status"),
      cell: (row) => <StatePill tone={TONE[statusOf(row)]}>{t(`status_${statusOf(row)}`)}</StatePill>,
    },
    {
      id: "lastSeen",
      header: t("lastSeen"),
      priority: 3,
      cell: (row) =>
        row.lastSeenAt ? (
          <span className="tabular-nums">{format.dateTime(new Date(row.lastSeenAt), "medium")}</span>
        ) : (
          <span className="text-kumo-subtle">{t("neverSignedIn")}</span>
        ),
    },
  ];

  function actionsOf(row: Account): RowAction[] {
    const mine = row.id === self.data?.id;
    const actions: RowAction[] = [{ key: "edit", label: t("edit"), icon: UserGearIcon, onSelect: () => open(row) }];
    if (row.active) {
      actions.push({
        key: "invite",
        label: t("resend"),
        icon: EnvelopeSimpleIcon,
        disabled: resend.isPending && resend.variables?.id === row.id,
        onSelect: () => resend.mutate(row),
      });
    } else {
      actions.push({
        key: "unlock",
        label: t("unlock"),
        icon: LockOpenIcon,
        disabled: lock.isPending,
        onSelect: () => lock.mutate({ one: row, active: true }),
      });
    }
    if (!mine && row.active) {
      actions.push({
        key: "lock",
        label: t("lock"),
        icon: LockIcon,
        danger: true,
        onSelect: () => {
          setFault(null);
          setLocking(row);
        },
      });
    }
    if (!mine && row.pending) {
      actions.push({
        key: "remove",
        label: t("removeInvite"),
        icon: TrashIcon,
        danger: true,
        onSelect: () => {
          setFault(null);
          setDropping(row);
        },
      });
    }
    return actions;
  }

  const faultBanner = fault ? <Banner variant="error" icon={<WarningCircleIcon weight="fill" />} title={fault} className="mt-4" /> : null;

  return (
    <>
      <PageHeader
        title={t("title")}
        description={t("lead")}
        actions={
          <Button variant="primary" icon={PlusIcon} onClick={() => open(null)}>
            {t("add")}
          </Button>
        }
      />

      <PageLayout>
        <FilterBar
          search={{ value: typed, onChange: setTyped, placeholder: t("searchHint") }}
          filters={[
            {
              key: "role",
              label: t("role"),
              value: url.role,
              onChange: (next) => setUrl({ role: next }),
              items: { "": t("anyRole"), ...Object.fromEntries(ROLES.map((one) => [one, roleName(one)])) },
              counts: counts.data?.byRole,
            },
            {
              key: "department",
              label: t("department"),
              value: url.departmentId,
              searchable: true,
              onChange: (next) => setUrl({ departmentId: next }),
              items: { "": t("anyDepartment"), ...Object.fromEntries((departments.data ?? []).map((one) => [one.id, one.name])) },
            },
            {
              key: "status",
              label: t("status"),
              value: url.status,
              onChange: (next) => setUrl({ status: next }),
              items: { "": t("anyStatus"), ...Object.fromEntries(STATUSES.map((one) => [one, t(`status_${one}`)])) },
              counts: counts.data?.byStatus,
            },
          ]}
        />
        <DataTable
          id="users"
          columns={columns}
          cardLead="account"
          cardTrailing="status"
          rows={loaded}
          keyOf={(row) => row.id}
          pending={accounts.isPending}
          failed={accounts.isError}
          onRetry={() => void accounts.refetch()}
          onRowClick={open}
          rowActions={actionsOf}
          empty={filtering ? t("noMatch") : undefined}
          paging={
            first
              ? {
                  shown: loaded?.length ?? 0,
                  total: first.total,
                  exact: first.totalIsExact,
                  onMore: accounts.hasNextPage ? () => void accounts.fetchNextPage() : undefined,
                  loading: accounts.isFetchingNextPage,
                }
              : undefined
          }
        />
      </PageLayout>

      <LayerDialog.Root open={draft !== null} onOpenChange={(next) => !next && setDraft(null)} dismissDisabled={save.isPending}>
        <LayerDialog.Content closeLabel={common("close")}>
          <LayerDialog.Title>{draft?.account ? t("editTitle") : t("add")}</LayerDialog.Title>
          <LayerDialog.Description>
            {draft?.account ? t("editLead", { email: draft.account.email }) : t("inviteLead")}
          </LayerDialog.Description>
          <LayerDialog.Body>
            {draft ? (
              <div className="flex flex-col gap-4">
                <Select
                  label={t("role")}
                  hideLabel={false}
                  value={draft.role}
                  onValueChange={(next) => setDraft({ ...draft, role: (String(next ?? "VIEWER") as Role) })}
                  items={Object.fromEntries(ROLES.map((one) => [one, roleName(one)]))}
                  description={t(`roleHint_${draft.role}`)}
                  className="w-full"
                />
                <PersonPicker
                  label={t("person")}
                  description={needsPerson ? t("personNeeded", { role: roleName(draft.role) }) : t("personOptional")}
                  error={personMissing ? t("personMissing") : undefined}
                  value={draft.person}
                  onChange={(next) => void pick(next)}
                />
                <Input
                  label={t("email")}
                  type="email"
                  required
                  maxLength={kEmailMax}
                  value={draft.email}
                  onChange={(event) => setDraft({ ...draft, email: event.target.value })}
                  description={t("emailHint")}
                  error={emailWrong ? t("emailInvalid") : undefined}
                />
                {faultBanner}
              </div>
            ) : null}
          </LayerDialog.Body>
          <LayerDialog.Actions dismissLabel={common("cancel")}>
            <LayerDialog.Actions.Primary loading={save.isPending} onClick={() => draft && submit(draft)}>
              {draft?.account ? common("save") : t("sendInvite")}
            </LayerDialog.Actions.Primary>
          </LayerDialog.Actions>
        </LayerDialog.Content>
      </LayerDialog.Root>

      <LayerDialog.Alert
        open={locking !== null}
        onOpenChange={(next) => !next && setLocking(null)}
        dismissDisabled={lock.isPending}
      >
        <LayerDialog.Content closeLabel={common("close")}>
          <LayerDialog.Title>{locking ? t("lockTitle", { email: locking.email }) : ""}</LayerDialog.Title>
          <LayerDialog.Description>
            {locking ? t("lockWarn", { name: locking.employee?.fullName ?? locking.email }) : ""}
          </LayerDialog.Description>
          <LayerDialog.Body>{faultBanner}</LayerDialog.Body>
          <LayerDialog.Actions dismissLabel={common("cancel")}>
            <LayerDialog.Actions.Primary
              variant="destructive"
              loading={lock.isPending}
              onClick={() => locking && lock.mutate({ one: locking, active: false })}
            >
              {t("lockGo")}
            </LayerDialog.Actions.Primary>
          </LayerDialog.Actions>
        </LayerDialog.Content>
      </LayerDialog.Alert>

      <LayerDialog.Alert
        open={dropping !== null}
        onOpenChange={(next) => !next && setDropping(null)}
        dismissDisabled={remove.isPending}
      >
        <LayerDialog.Content closeLabel={common("close")}>
          <LayerDialog.Title>{dropping ? t("removeTitle", { email: dropping.email }) : ""}</LayerDialog.Title>
          <LayerDialog.Description>{t("removeWarn")}</LayerDialog.Description>
          <LayerDialog.Body>{faultBanner}</LayerDialog.Body>
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

// The filters live in the query string, which the prerender does not have.
export default function UsersPage() {
  return (
    <Suspense>
      <Accounts />
    </Suspense>
  );
}
