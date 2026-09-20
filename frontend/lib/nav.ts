import {
  CalendarCheck,
  CalendarDays,
  ChartColumn,
  Clock,
  Cpu,
  FileText,
  Inbox,
  LayoutDashboard,
  Network,
  Receipt,
  Scale,
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
  /** Kept out of the phone's nav; the top bar carries it beside sign-out. */
  deskOnly?: boolean;
}

export interface NavGroup {
  key: NavKey;
  items: NavItem[];
}

const EVERYONE: Role[] = [];
const DECIDERS: Role[] = ["MANAGER", "ADMIN", "HR"];
const PEOPLE_DESK: Role[] = ["ADMIN", "HR", "PAYROLL"];
const OPERATORS: Role[] = ["ADMIN"];

/** Screens grouped by what somebody is doing, not by module (KEHOACH 9.15). */
export const NAV: NavGroup[] = [
  {
    key: "me",
    items: [
      { href: "/me", key: "myPage", icon: User, roles: EVERYONE },
      { href: "/me/attendance", key: "myAttendance", icon: CalendarCheck, roles: EVERYONE },
      { href: "/me/requests", key: "myLeave", icon: FileText, roles: EVERYONE },
      { href: "/me/payslips", key: "myPayslips", icon: Receipt, roles: EVERYONE },
    ],
  },
  {
    key: "groupApprovals",
    items: [
      { href: "/approvals", key: "approvals", icon: Inbox, roles: DECIDERS, badge: "approvals" },
    ],
  },
  {
    key: "groupPeople",
    items: [
      { href: "/employees", key: "directory", icon: Users, roles: PEOPLE_DESK },
      { href: "/org", key: "orgChart", icon: Network, roles: PEOPLE_DESK },
      { href: "/org/departments", key: "departments", icon: Network, roles: PEOPLE_DESK },
    ],
  },
  {
    key: "groupTime",
    items: [
      { href: "/timesheet", key: "timesheetHr", icon: CalendarDays, roles: PEOPLE_DESK },
      { href: "/attendance", key: "attendance", icon: CalendarCheck, roles: PEOPLE_DESK },
      { href: "/leave", key: "leave", icon: FileText, roles: PEOPLE_DESK },
      { href: "/shifts", key: "shifts", icon: Clock, roles: PEOPLE_DESK },
    ],
  },
  {
    key: "groupPay",
    items: [
      { href: "/payroll", key: "payroll", icon: Wallet, roles: PEOPLE_DESK },
      { href: "/policy", key: "policy", icon: Scale, roles: PEOPLE_DESK },
    ],
  },
  {
    key: "groupDevices",
    items: [
      { href: "/overview", key: "overview", icon: LayoutDashboard, roles: OPERATORS },
      { href: "/devices", key: "devices", icon: Cpu, roles: OPERATORS },
    ],
  },
  {
    key: "groupReports",
    items: [{ href: "/reports", key: "reports", icon: ChartColumn, roles: PEOPLE_DESK }],
  },
  {
    key: "groupSettings",
    items: [{ href: "/settings", key: "settings", icon: Settings, roles: EVERYONE, deskOnly: true }],
  },
];

/** An empty group is hidden, not greyed (KEHOACH 9.15). */
export function navFor(role: Role | null): NavGroup[] {
  return NAV.map((group) => ({
    ...group,
    items: group.items.filter((item) => !item.roles?.length || (role !== null && item.roles.includes(role))),
  })).filter((group) => group.items.length > 0);
}

const kTabSlots = 5;

// The four of KEHOACH 9.21.1 with the manager's fifth in the place it earns:
// above payslips, so the badge survives on a role with too many destinations.
const TAB_ORDER: NavKey[] = ["myPage", "approvals", "myAttendance", "myLeave", "myPayslips"];

export interface TabLayout {
  items: NavItem[];
  rest: NavGroup[];
}

/** Five targets fit across a phone, so a longer menu keeps its tail in a sheet.
 *  The sheet holds only what the tabs left out: a destination in both places
 *  makes the menu look long while saying nothing new.
 */
export function tabsFor(role: Role | null): TabLayout {
  const groups = navFor(role).map((group) => ({
    ...group,
    items: group.items.filter((item) => !item.deskOnly),
  }));
  const flat = groups.flatMap((group) => group.items);
  const ranked = TAB_ORDER.map((key) => flat.find((item) => item.key === key)).filter(
    (item): item is NavItem => item !== undefined,
  );
  // The menu button is a slot like any other, so a role that needs one gets
  // four destinations and not five.
  const needsMenu = flat.length > kTabSlots;
  const items = ranked.slice(0, needsMenu ? kTabSlots - 1 : kTabSlots);
  const shown = new Set(items.map((item) => item.href));
  const rest = needsMenu
    ? groups
        .map((group) => ({ ...group, items: group.items.filter((item) => !shown.has(item.href)) }))
        .filter((group) => group.items.length > 0)
    : [];
  return { items, rest };
}
