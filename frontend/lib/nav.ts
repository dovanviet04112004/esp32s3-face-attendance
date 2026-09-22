import {
  CalendarCheck,
  CalendarDays,
  CalendarOff,
  CalendarRange,
  ChartColumn,
  Clock,
  Cpu,
  BookOpenCheck,
  FileText,
  Flag,
  FolderCheck,
  Inbox,
  LayoutDashboard,
  ListChecks,
  Network,
  Package,
  Receipt,
  Scale,
  ScanFace,
  ScrollText,
  Settings,
  User,
  UserCog,
  Users,
  Wallet,
  type LucideIcon,
} from "lucide-react";

import type viMessages from "../messages/vi.json";
import type { Role } from "./auth";

// A renamed message breaks the build here, not the sidebar (CLAUDE.md 3.1).
type NavKey = keyof (typeof viMessages)["nav"];

export interface NavItem {
  href: string;
  key: NavKey;
  icon: LucideIcon;
  roles?: Role[];
  badge?: "approvals";
  /** Kept out of the phone's tab bar; the top bar carries it (KEHOACH 9.21.1). */
  deskOnly?: boolean;
  /** Judged by the guard, skipped by the menu (KEHOACH 9.15). */
  unlisted?: boolean;
}

export interface NavGroup {
  key: NavKey;
  items: NavItem[];
}

const EVERYONE: Role[] = [];
const DECIDERS: Role[] = ["ADMIN", "HR", "PAYROLL", "MANAGER"];
// Every page here narrows to the manager's own subtree (KEHOACH 9.4).
const TEAM: Role[] = ["ADMIN", "HR", "PAYROLL", "MANAGER"];
const TEAM_TIME: Role[] = ["ADMIN", "HR", "MANAGER"];
const PEOPLE_DESK: Role[] = ["ADMIN", "HR"];
const PAY_DESK: Role[] = ["ADMIN", "HR", "PAYROLL"];
const OPERATORS: Role[] = ["ADMIN"];
const DAY_DESK: Role[] = ["ADMIN", "HR", "PAYROLL"];

/** Screens grouped by what somebody is doing, not by module (KEHOACH 9.15). */
export const NAV: NavGroup[] = [
  {
    key: "groupToday",
    items: [{ href: "/overview", key: "overview", icon: LayoutDashboard, roles: DAY_DESK }],
  },
  {
    key: "me",
    items: [
      { href: "/me", key: "myPage", icon: User, roles: EVERYONE },
      { href: "/me/attendance", key: "myAttendance", icon: CalendarCheck, roles: EVERYONE },
      { href: "/me/shifts", key: "myShifts", icon: CalendarRange, roles: EVERYONE },
      { href: "/me/requests", key: "myLeave", icon: FileText, roles: EVERYONE },
      { href: "/me/payslips", key: "myPayslips", icon: Receipt, roles: EVERYONE },
      {
        href: "/me/documents",
        key: "myDocuments",
        icon: BookOpenCheck,
        roles: EVERYONE,
        deskOnly: true,
      },
    ],
  },
  {
    key: "groupApprovals",
    items: [
      {
        href: "/approvals",
        key: "approvals",
        icon: Inbox,
        roles: DECIDERS,
        badge: "approvals",
        deskOnly: true,
      },
    ],
  },
  {
    key: "groupPeople",
    items: [
      { href: "/employees", key: "directory", icon: Users, roles: TEAM },
      {
        href: "/employees/new",
        key: "directory",
        icon: Users,
        roles: PEOPLE_DESK,
        unlisted: true,
      },
      { href: "/org", key: "orgChart", icon: Network, roles: TEAM_TIME },
      { href: "/onboarding", key: "onboarding", icon: ListChecks, roles: TEAM_TIME, deskOnly: true },
      { href: "/assets", key: "assets", icon: Package, roles: PEOPLE_DESK, deskOnly: true },
      { href: "/documents", key: "documents", icon: FolderCheck, roles: PEOPLE_DESK, deskOnly: true },
    ],
  },
  {
    key: "groupTime",
    items: [
      { href: "/timesheet", key: "timesheetHr", icon: CalendarDays, roles: TEAM },
      { href: "/attendance", key: "attendance", icon: ScanFace, roles: TEAM },
      { href: "/leave", key: "leave", icon: CalendarOff, roles: TEAM_TIME },
      { href: "/shifts", key: "shifts", icon: Clock, roles: PEOPLE_DESK },
      { href: "/holidays", key: "holidays", icon: Flag, roles: PEOPLE_DESK },
      { href: "/reports", key: "reports", icon: ChartColumn, roles: PAY_DESK },
    ],
  },
  {
    key: "groupPay",
    items: [
      { href: "/payroll", key: "payroll", icon: Wallet, roles: PAY_DESK },
      { href: "/policy", key: "policy", icon: Scale, roles: PAY_DESK },
    ],
  },
  {
    key: "groupOps",
    items: [{ href: "/devices", key: "devices", icon: Cpu, roles: OPERATORS }],
  },
  {
    key: "groupSettings",
    items: [
      { href: "/leave-types", key: "leaveTypes", icon: CalendarOff, roles: PEOPLE_DESK, deskOnly: true },
      { href: "/users", key: "users", icon: UserCog, roles: OPERATORS, deskOnly: true },
      { href: "/audit", key: "audit", icon: ScrollText, roles: OPERATORS, deskOnly: true },
      { href: "/settings", key: "settings", icon: Settings, roles: EVERYONE, deskOnly: true },
    ],
  },
];

/** An empty group is hidden, not greyed (KEHOACH 9.15). An account with no
 *  employee record has no self service to do, so that group goes too.
 */
export function navFor(role: Role | null, hasRecord = true): NavGroup[] {
  return NAV.map((group) => ({
    ...group,
    items:
      group.key === "me" && !hasRecord
        ? []
        : group.items.filter(
            (item) =>
              !item.unlisted &&
              (!item.roles?.length || (role !== null && item.roles.includes(role))),
          ),
  })).filter((group) => group.items.length > 0);
}

// Longest first: Departments sits under the org chart but is narrower.
const BY_DEPTH: NavItem[] = NAV.flatMap((group) => group.items).sort(
  (left, right) => right.href.length - left.href.length,
);

/** The menu entry a path belongs to, which a detail page has and never is. */
export function ownerOf(path: string): NavItem | undefined {
  return BY_DEPTH.find((item) => path === item.href || path.startsWith(`${item.href}/`));
}

/** Whether this account may open this path. No row means no opening it. */
export function allows(role: Role | null, hasRecord: boolean, path: string): boolean {
  const owner = ownerOf(path);
  if (!owner) {
    return false;
  }
  if (owner.roles?.length) {
    return role !== null && owner.roles.includes(role);
  }
  return navFor(role, hasRecord).some((group) =>
    group.items.some((item) => item.href === owner.href),
  );
}

/** The first destination of this account's own list (KEHOACH 9.15). */
export function homeFor(role: Role | null, hasRecord: boolean): string {
  const groups = navFor(role, hasRecord);
  return groups[0]?.items[0]?.href ?? "/settings";
}

export interface Crumb {
  key: NavKey;
  href: string | null;
}

/** The way back from a sub-page, read off the table so it never points at a
 *  page this role cannot open. A parent page gets none (KEHOACH 9.15).
 */
export function crumbsFor(role: Role | null, hasRecord: boolean, path: string): Crumb[] {
  const owner = ownerOf(path);
  if (!owner || owner.href === path) {
    return [];
  }
  for (const group of navFor(role, hasRecord)) {
    if (group.items.some((item) => item.href === owner.href)) {
      return [
        { key: group.key, href: null },
        { key: owner.key, href: owner.href },
      ];
    }
  }
  return [];
}

const kTabSlots = 5;

// The five of KEHOACH 9.21.1, in the order somebody opens the app to ask.
const TAB_ORDER: NavKey[] = ["myPage", "myShifts", "myAttendance", "myLeave", "myPayslips"];

export interface TabLayout {
  items: NavItem[];
  rest: NavGroup[];
}

/** Five targets fit across a phone, so a longer menu keeps its tail in a sheet.
 *  The sheet holds only what the tabs left out: a destination in both places
 *  makes the menu look long while saying nothing new.
 */
export function tabsFor(role: Role | null, hasRecord = true): TabLayout {
  const groups = navFor(role, hasRecord).map((group) => ({
    ...group,
    items: group.items.filter((item) => !item.deskOnly),
  }));
  const flat = groups.flatMap((group) => group.items);
  const ranked = TAB_ORDER.map((key) => flat.find((item) => item.key === key)).filter(
    (item): item is NavItem => item !== undefined,
  );
  // An account with no record of its own has none of the five.
  const pool = ranked.length > 0 ? ranked : flat;
  // The menu button is a slot like any other, so a role that needs one gets
  // four destinations and not five.
  const needsMenu = flat.length > kTabSlots;
  const items = pool.slice(0, needsMenu ? kTabSlots - 1 : kTabSlots);
  const shown = new Set(items.map((item) => item.href));
  const rest = needsMenu
    ? groups
        .map((group) => ({ ...group, items: group.items.filter((item) => !shown.has(item.href)) }))
        .filter((group) => group.items.length > 0)
    : [];
  return { items, rest };
}
