import type viMessages from "../messages/vi.json";
import type { Role } from "./auth";

// A renamed message breaks the build here, not the sidebar (CLAUDE.md 3.1).
type NavKey = keyof (typeof viMessages)["nav"];

export interface NavItem {
  href: string;
  key: NavKey;
  roles?: Role[];
  badge?: "approvals";
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
      { href: "/me", key: "myPage", roles: EVERYONE },
      { href: "/me/attendance", key: "myAttendance", roles: EVERYONE },
      { href: "/me/requests", key: "myLeave", roles: EVERYONE },
    ],
  },
  {
    key: "groupApprovals",
    items: [{ href: "/approvals", key: "approvals", roles: DECIDERS, badge: "approvals" }],
  },
  {
    key: "groupPeople",
    items: [
      { href: "/employees", key: "directory", roles: PEOPLE_DESK },
      { href: "/org", key: "orgChart", roles: PEOPLE_DESK },
    ],
  },
  {
    key: "groupTime",
    items: [
      { href: "/attendance", key: "timesheet", roles: PEOPLE_DESK },
      { href: "/leave", key: "leave", roles: PEOPLE_DESK },
      { href: "/shifts", key: "shifts", roles: PEOPLE_DESK },
    ],
  },
  {
    key: "groupDevices",
    items: [
      { href: "/overview", key: "overview", roles: OPERATORS },
      { href: "/devices", key: "devices", roles: OPERATORS },
    ],
  },
  {
    key: "groupReports",
    items: [{ href: "/reports", key: "reports", roles: PEOPLE_DESK }],
  },
  {
    key: "groupSettings",
    items: [{ href: "/settings", key: "settings", roles: EVERYONE }],
  },
];

/** An empty group is hidden, not greyed (KEHOACH 9.15). */
export function navFor(role: Role | null): NavGroup[] {
  return NAV.map((group) => ({
    ...group,
    items: group.items.filter((item) => !item.roles?.length || (role !== null && item.roles.includes(role))),
  })).filter((group) => group.items.length > 0);
}
