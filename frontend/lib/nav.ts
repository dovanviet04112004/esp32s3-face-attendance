import {
  Building2,
  CalendarCheck,
  CalendarDays,
  CalendarOff,
  CalendarRange,
  ChartColumn,
  Clock,
  Cpu,
  BookOpenCheck,
  FileText,
  FolderCheck,
  Inbox,
  LayoutDashboard,
  Network,
  Receipt,
  Scale,
  ScanFace,
  Settings,
  User,
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

/** Screens grouped by what somebody is doing, not by module (KEHOACH 9.15). */
export const NAV: NavGroup[] = [
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
      { href: "/org", key: "orgChart", icon: Network, roles: TEAM_TIME },
      { href: "/org/departments", key: "departments", icon: Building2, roles: PEOPLE_DESK },
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
    items: [
      { href: "/overview", key: "overview", icon: LayoutDashboard, roles: OPERATORS },
      { href: "/devices", key: "devices", icon: Cpu, roles: OPERATORS },
    ],
  },
  {
    key: "groupSettings",
    items: [{ href: "/settings", key: "settings", icon: Settings, roles: EVERYONE, deskOnly: true }],
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
            (item) => !item.roles?.length || (role !== null && item.roles.includes(role)),
          ),
  })).filter((group) => group.items.length > 0);
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
