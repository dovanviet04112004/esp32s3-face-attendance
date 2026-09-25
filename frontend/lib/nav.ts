import type { Icon as IconType } from "@phosphor-icons/react";
import {
  BooksIcon,
  BookOpenTextIcon,
  BriefcaseIcon,
  BuildingsIcon,
  CalendarBlankIcon,
  CalendarCheckIcon,
  CalendarIcon,
  CalendarXIcon,
  ChartBarIcon,
  ClockIcon,
  CoinsIcon,
  CpuIcon,
  FileTextIcon,
  FilesIcon,
  FlagIcon,
  GearIcon,
  ListChecksIcon,
  PackageIcon,
  ReceiptIcon,
  ScalesIcon,
  ScrollIcon,
  SquaresFourIcon,
  TagIcon,
  TrayIcon,
  TreeStructureIcon,
  UserFocusIcon,
  UserGearIcon,
  UserIcon,
  UsersIcon,
  WalletIcon,
} from "@phosphor-icons/react";

import type viMessages from "../messages/vi.json";
import type { Role } from "./auth";

// A renamed message breaks the build here, not the sidebar (CLAUDE.md 3.1).
type NavKey = keyof (typeof viMessages)["nav"];

type SectionKey = "mine" | "inbox" | "people" | "time" | "calendar" | "pay" | "catalogues" | "system";

export interface NavItem {
  href: string;
  key: NavKey;
  icon: IconType;
  roles?: Role[];
  badge?: "approvals";
  /** Kept out of the phone's tab bar; the top bar carries it (KEHOACH 9.21.1). */
  deskOnly?: boolean;
  /** Reachable on a phone, but never one of the five tabs: the "More" sheet lists it (KEHOACH 9.21.5). */
  tabless?: boolean;
  /** Judged by the guard, skipped by the menu (KEHOACH 9.15). */
  unlisted?: boolean;
  /** Sibling pages of one sidebar entry, joined by the section bar (KEHOACH 9.15). */
  section?: SectionKey;
}

export interface NavGroup {
  key: NavKey;
  items: NavItem[];
}

interface Section {
  key: NavKey;
  icon: IconType;
  short?: NavKey;
}

const SECTIONS: Record<SectionKey, Section> = {
  mine: { key: "myRequests", icon: FileTextIcon, short: "myRequestsShort" },
  inbox: { key: "approvals", icon: TrayIcon },
  people: { key: "employees", icon: UsersIcon },
  time: { key: "sectionTime", icon: CalendarBlankIcon },
  calendar: { key: "sectionCalendar", icon: ClockIcon },
  pay: { key: "sectionPay", icon: WalletIcon },
  catalogues: { key: "sectionCatalogues", icon: BooksIcon },
  system: { key: "sectionSystem", icon: UserGearIcon },
};

const EVERYONE: Role[] = [];
const DECIDERS: Role[] = ["ADMIN", "HR", "PAYROLL", "MANAGER"];
// Every page here narrows to the manager's own subtree (KEHOACH 9.4).
const TEAM: Role[] = ["ADMIN", "HR", "PAYROLL", "MANAGER"];
const TEAM_TIME: Role[] = ["ADMIN", "HR", "MANAGER"];
const PEOPLE_DESK: Role[] = ["ADMIN", "HR"];
const PAY_DESK: Role[] = ["ADMIN", "HR", "PAYROLL"];
const OPERATORS: Role[] = ["ADMIN"];
const DAY_DESK: Role[] = ["ADMIN", "HR", "PAYROLL"];
// Payroll keeps the allowance catalogue; HR reads it to write pay (KEHOACH 9.15).
const ALLOWANCE_DESK: Role[] = ["ADMIN", "HR", "PAYROLL"];

/** Screens grouped by what somebody is doing, not by module (KEHOACH 9.15). */
export const NAV: NavGroup[] = [
  {
    key: "groupToday",
    items: [{ href: "/overview", key: "overview", icon: SquaresFourIcon, roles: DAY_DESK }],
  },
  {
    key: "me",
    items: [
      { href: "/me", key: "myPage", icon: UserIcon, roles: EVERYONE },
      { href: "/me/attendance", key: "myAttendance", icon: CalendarCheckIcon, roles: EVERYONE },
      { href: "/me/shifts", key: "myShifts", icon: CalendarIcon, roles: EVERYONE },
      { href: "/me/requests", key: "myLeave", icon: FileTextIcon, roles: EVERYONE, section: "mine" },
      { href: "/me/letters", key: "myLetters", icon: FileTextIcon, roles: EVERYONE, section: "mine" },
      { href: "/me/profile", key: "myProfile", icon: FileTextIcon, roles: EVERYONE, section: "mine" },
      { href: "/me/payslips", key: "myPayslips", icon: ReceiptIcon, roles: EVERYONE },
      {
        href: "/me/documents",
        key: "myDocuments",
        icon: BookOpenTextIcon,
        roles: EVERYONE,
        tabless: true,
      },
    ],
  },
  {
    key: "groupApprovals",
    items: [
      {
        href: "/approvals",
        key: "approvalsWaiting",
        icon: TrayIcon,
        roles: DECIDERS,
        badge: "approvals",
        deskOnly: true,
        section: "inbox",
      },
      { href: "/leave", key: "leave", icon: CalendarXIcon, roles: TEAM_TIME, section: "inbox" },
    ],
  },
  {
    key: "groupPeople",
    items: [
      { href: "/employees", key: "directory", icon: UsersIcon, roles: TEAM, section: "people" },
      {
        href: "/employees/new",
        key: "directory",
        icon: UsersIcon,
        roles: PEOPLE_DESK,
        unlisted: true,
        section: "people",
      },
      { href: "/org", key: "orgChart", icon: TreeStructureIcon, roles: TEAM_TIME, section: "people" },
      { href: "/onboarding", key: "onboarding", icon: ListChecksIcon, roles: TEAM_TIME, deskOnly: true },
      { href: "/assets", key: "assets", icon: PackageIcon, roles: PEOPLE_DESK, deskOnly: true },
      { href: "/documents", key: "documents", icon: FilesIcon, roles: PEOPLE_DESK, deskOnly: true },
    ],
  },
  {
    key: "groupTime",
    items: [
      { href: "/timesheet", key: "timesheetHr", icon: CalendarBlankIcon, roles: TEAM, section: "time" },
      { href: "/attendance", key: "attendance", icon: UserFocusIcon, roles: TEAM, section: "time" },
      { href: "/shifts", key: "shifts", icon: ClockIcon, roles: PEOPLE_DESK, section: "calendar" },
      { href: "/holidays", key: "holidays", icon: FlagIcon, roles: PEOPLE_DESK, section: "calendar" },
      {
        href: "/leave-types",
        key: "leaveTypes",
        icon: TagIcon,
        roles: PEOPLE_DESK,
        deskOnly: true,
        section: "calendar",
      },
      { href: "/reports", key: "reports", icon: ChartBarIcon, roles: PAY_DESK },
    ],
  },
  {
    key: "groupPay",
    items: [
      { href: "/payroll", key: "payroll", icon: WalletIcon, roles: PAY_DESK, section: "pay" },
      { href: "/policy", key: "policy", icon: ScalesIcon, roles: PAY_DESK, section: "pay" },
    ],
  },
  {
    key: "groupOps",
    items: [{ href: "/devices", key: "devices", icon: CpuIcon, roles: OPERATORS }],
  },
  {
    key: "groupSettings",
    items: [
      {
        href: "/job-titles",
        key: "jobTitles",
        icon: BriefcaseIcon,
        roles: PEOPLE_DESK,
        deskOnly: true,
        section: "catalogues",
      },
      {
        href: "/legal-entities",
        key: "legalEntities",
        icon: BuildingsIcon,
        roles: OPERATORS,
        deskOnly: true,
        section: "catalogues",
      },
      {
        href: "/allowances",
        key: "allowances",
        icon: CoinsIcon,
        roles: ALLOWANCE_DESK,
        deskOnly: true,
        section: "catalogues",
      },
      { href: "/users", key: "users", icon: UserGearIcon, roles: OPERATORS, deskOnly: true, section: "system" },
      { href: "/audit", key: "audit", icon: ScrollIcon, roles: OPERATORS, deskOnly: true, section: "system" },
      { href: "/settings", key: "settings", icon: GearIcon, roles: EVERYONE, deskOnly: true },
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

export interface NavEntry {
  href: string;
  key: NavKey;
  short: NavKey;
  icon: IconType;
  badge?: "approvals";
  deskOnly?: boolean;
  tabless?: boolean;
  members: NavItem[];
}

export interface EntryGroup {
  key: NavKey;
  entries: NavEntry[];
}

/** The sidebar's rows: a section collapses into its first page this role may
 *  open, so no page sits both in the sidebar and in a section bar (KEHOACH 9.15).
 */
export function entriesFor(role: Role | null, hasRecord = true): EntryGroup[] {
  return navFor(role, hasRecord).map((group) => {
    const entries: NavEntry[] = [];
    for (const item of group.items) {
      const section = item.section ? SECTIONS[item.section] : undefined;
      const held = item.section
        ? entries.find((entry) => entry.members[0]?.section === item.section)
        : undefined;
      if (held) {
        held.members.push(item);
        held.badge ??= item.badge;
        continue;
      }
      entries.push({
        href: item.href,
        key: section?.key ?? item.key,
        short: section?.short ?? section?.key ?? item.key,
        icon: section?.icon ?? item.icon,
        badge: item.badge,
        deskOnly: item.deskOnly,
        tabless: item.tabless,
        members: [item],
      });
    }
    return { key: group.key, entries };
  });
}

const BY_DEPTH: NavItem[] = NAV.flatMap((group) => group.items).sort(
  (left, right) => right.href.length - left.href.length,
);

/** The menu entry a path belongs to, which a detail page has and never is. */
export function ownerOf(path: string): NavItem | undefined {
  return BY_DEPTH.find((item) => path === item.href || path.startsWith(`${item.href}/`));
}

export function entryOf(groups: EntryGroup[], path: string): NavEntry | undefined {
  const owner = ownerOf(path);
  if (!owner) {
    return undefined;
  }
  return groups
    .flatMap((group) => group.entries)
    .find((entry) =>
      entry.members.some(
        (member) => member.href === owner.href || (owner.section && member.section === owner.section),
      ),
    );
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

/** The sibling pages the section bar shows on this page, or none: a section
 *  this role opens one page of, or a page inside a record, has no bar.
 */
export function siblingsOf(role: Role | null, hasRecord: boolean, path: string): NavItem[] {
  const owner = ownerOf(path);
  if (!owner?.section || owner.href !== path || owner.unlisted) {
    return [];
  }
  const members = navFor(role, hasRecord)
    .flatMap((group) => group.items)
    .filter((item) => item.section === owner.section);
  return members.length > 1 ? members : [];
}

export interface Crumb {
  key: NavKey;
  href: string;
}

/** The entry, then the sibling page when the entry is a section, read off the
 *  table so it never points at a page this role cannot open (KEHOACH 9.15).
 */
export function trailFor(role: Role | null, hasRecord: boolean, path: string): Crumb[] {
  const owner = ownerOf(path);
  const entry = entryOf(entriesFor(role, hasRecord), path);
  if (!owner || !entry) {
    return [];
  }
  const trail: Crumb[] = [{ key: entry.key, href: entry.href }];
  if (owner.section && !owner.unlisted) {
    trail.push({ key: owner.key, href: owner.href });
  }
  return trail;
}

/** A record, or a page that is no menu destination, names itself in the trail. */
export function namesItself(path: string): boolean {
  const owner = ownerOf(path);
  return owner !== undefined && (owner.href !== path || owner.unlisted === true);
}

const kTabSlots = 5;

// The five of KEHOACH 9.21.1, in the order somebody opens the app to ask.
const TAB_ORDER: NavKey[] = ["myPage", "myShifts", "myAttendance", "myRequests", "myPayslips"];

export interface TabLayout {
  items: NavEntry[];
  rest: EntryGroup[];
}

/** Five targets fit across a phone, so a longer menu keeps its tail in a sheet.
 *  The sheet holds only what the tabs left out: a destination in both places
 *  makes the menu look long while saying nothing new.
 */
export function tabsFor(role: Role | null, hasRecord = true): TabLayout {
  const groups = entriesFor(role, hasRecord).map((group) => ({
    ...group,
    entries: group.entries.filter((entry) => !entry.deskOnly),
  }));
  const flat = groups.flatMap((group) => group.entries).filter((entry) => !entry.tabless);
  const ranked = TAB_ORDER.map((key) => flat.find((entry) => entry.key === key)).filter(
    (entry): entry is NavEntry => entry !== undefined,
  );
  // An account with no record of its own has none of the five.
  const pool = ranked.length > 0 ? ranked : flat;
  // The menu button is a slot like any other, so a role that needs one gets
  // four destinations and not five.
  const needsMenu = flat.length > kTabSlots;
  const items = pool.slice(0, needsMenu ? kTabSlots - 1 : kTabSlots);
  const shown = new Set(items.map((entry) => entry.href));
  const rest = needsMenu
    ? groups
        .map((group) => ({ ...group, entries: group.entries.filter((entry) => !shown.has(entry.href)) }))
        .filter((group) => group.entries.length > 0)
    : [];
  return { items, rest };
}
