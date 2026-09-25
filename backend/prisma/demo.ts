import "reflect-metadata";

import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "@prisma/client";
import "dotenv/config";

import { validateEnv } from "../src/config/env.schema.js";
import { calculate, type CalcAllowance } from "../src/modules/payroll/calculate.js";
import { asCalcPolicy } from "../src/modules/policy/policy.service.js";
import { localDay } from "../src/modules/timesheet/local-day.js";

const HEADCOUNT = 5000;
// One company per seed: a screenshot in the report has to match the machine.
const SEED = 20_260_922;
const YEAR = 2026;
// Punches stop at the current month, because a kiosk cannot record next week.
const LAST_MONTH = 9;
const ENTITY_CODE = "DEFAULT";
const ENTITY_NAME = "Công ty TNHH Cơ khí Chính xác Tân Hưng";
const ENTITY_TAX_CODE = "0312456789";
const ENTITY_ADDRESS = "Lô B2-4, KCN Tân Bình, Quận Tân Phú, TP. Hồ Chí Minh";
// Addresses this file mints, which is also what tells it apart from a login
// somebody else opened: it only ever cleans up its own.
const PERSON_EMAIL_DOMAIN = "thanhung.example";
const WRITE_CHUNK = 4000;
const PEOPLE_CHUNK = 500;

const MINUTES_PER_HOUR = 60;
const FULL_DAY_MINUTES = 480;
const BREAK_MINUTES = 60;
const LEAVER_SHARE = 0.05;
const OT_WORKER_SHARE = 0.2;
const ABSENT_CHANCE = 0.012;
const LEAVE_CHANCE = 0.012;
const LEAVE_SPELL_MAX = 4;
const LATE_CHANCE = 0.09;
const SUNDAY_OT_CHANCE = 0.05;
// Years of service, from none to ten: a plant that grew in steps rather than
// along a curve, and whose intake has to square with who leaves.
const TENURE_WEIGHTS = [12, 14, 13, 12, 10, 9, 8, 7, 6, 5, 4];
const DEPENDENT_SHARE = 0.42;
// A kiosk keeps the punches; the rolled-up day is what answers for the rest of
// the year, which is the whole reason AttendanceDay exists (KEHOACH 9.8).
const PUNCH_MONTHS = 2;
const DEVICES = [
  { id: "kiosk-demo-cong-chinh", name: "Cổng chính", location: "Cổng số 1", kind: "OFFICE" as UnitKind },
  { id: "kiosk-demo-xuong-1", name: "Xưởng Lắp ráp 1", location: "Nhà xưởng A", kind: "PROD" as UnitKind },
  { id: "kiosk-demo-xuong-2", name: "Xưởng Điện tử SMT", location: "Nhà xưởng B", kind: "PROD" as UnitKind },
  { id: "kiosk-demo-van-phong", name: "Sảnh văn phòng", location: "Nhà điều hành", kind: "OFFICE" as UnitKind },
];
const PENDING_DEVICE = { id: "kiosk-demo-kho-moi", name: "Kho Thành phẩm", location: "Nhà kho C" };
const DESK_REQUESTS = 48;
const DESK_ADVANCES = 18;
const DESK_WINDOW_DAY = 23;
const ASSETS_PER_KIND = 60;

type UnitKind = "PROD" | "OFFICE";

interface Unit {
  code: string;
  name: string;
  kind: UnitKind;
  weight: number;
}

interface Block {
  code: string;
  name: string;
  units: Unit[];
}

function prod(code: string, name: string, weight: number): Unit {
  return { code, name, kind: "PROD", weight };
}

function office(code: string, name: string, weight: number): Unit {
  return { code, name, kind: "OFFICE", weight };
}

const BLOCKS: Block[] = [
  {
    code: "SX",
    name: "Khối Sản xuất",
    units: [
      prod("SX-LR1", "Xưởng Lắp ráp 1", 620),
      prod("SX-LR2", "Xưởng Lắp ráp 2", 540),
      prod("SX-CK", "Xưởng Gia công cơ khí", 480),
      prod("SX-DT", "Xưởng Điện tử SMT", 430),
      prod("SX-HT", "Xưởng Hoàn thiện", 350),
      prod("SX-KM", "Tổ Khuôn mẫu", 160),
      prod("SX-SP", "Tổ Sơn phủ", 190),
      prod("SX-DG", "Tổ Đóng gói", 280),
    ],
  },
  {
    code: "CL",
    name: "Khối Chất lượng",
    units: [
      office("CL-QA", "Phòng Đảm bảo chất lượng", 90),
      prod("CL-QC", "Tổ Kiểm soát chất lượng", 160),
      office("CL-DL", "Phòng Kiểm định đo lường", 45),
    ],
  },
  {
    code: "KT",
    name: "Khối Kỹ thuật",
    units: [
      office("KT-SX", "Phòng Kỹ thuật sản xuất", 130),
      prod("KT-BT", "Tổ Bảo trì", 180),
      office("KT-RD", "Phòng Nghiên cứu phát triển", 95),
      office("KT-IT", "Phòng Công nghệ thông tin", 55),
    ],
  },
  {
    code: "CU",
    name: "Khối Chuỗi cung ứng",
    units: [
      office("CU-MH", "Phòng Mua hàng", 70),
      office("CU-KH", "Phòng Kế hoạch sản xuất", 60),
      office("CU-XNK", "Phòng Xuất nhập khẩu", 45),
      prod("CU-KNL", "Kho Nguyên vật liệu", 110),
      prod("CU-KTP", "Kho Thành phẩm", 95),
    ],
  },
  {
    code: "KD",
    name: "Khối Kinh doanh",
    units: [
      office("KD-ND", "Phòng Kinh doanh nội địa", 130),
      office("KD-XK", "Phòng Kinh doanh xuất khẩu", 95),
      office("KD-MK", "Phòng Marketing", 50),
      office("KD-CS", "Phòng Chăm sóc khách hàng", 75),
    ],
  },
  {
    code: "TC",
    name: "Khối Tài chính",
    units: [
      office("TC-KT", "Phòng Kế toán", 95),
      office("TC-TC", "Phòng Tài chính", 45),
      office("TC-KS", "Phòng Kiểm soát nội bộ", 30),
    ],
  },
  {
    code: "NS",
    name: "Khối Nhân sự",
    units: [
      office("NS-TD", "Phòng Tuyển dụng", 45),
      office("NS-CB", "Phòng Tiền lương và Phúc lợi", 40),
      office("NS-DT", "Phòng Đào tạo", 35),
      office("NS-HC", "Phòng Hành chính", 85),
    ],
  },
  {
    code: "AT",
    name: "Khối An toàn và Môi trường",
    units: [
      office("AT-LD", "Phòng An toàn lao động", 55),
      office("AT-MT", "Phòng Môi trường", 30),
      office("AT-YT", "Tổ Y tế", 25),
    ],
  },
  {
    code: "TGD",
    name: "Ban Tổng giám đốc",
    units: [office("TGD-VP", "Văn phòng Tổng giám đốc", 22)],
  },
];

interface Title {
  code: string;
  name: string;
  grade: number;
}

const TITLES: Title[] = [
  { code: "CN1", name: "Công nhân", grade: 1 },
  { code: "CN2", name: "Công nhân bậc 2", grade: 2 },
  { code: "CN3", name: "Công nhân bậc 3", grade: 3 },
  { code: "KTV", name: "Kỹ thuật viên", grade: 3 },
  { code: "KTVC", name: "Kỹ thuật viên chính", grade: 4 },
  { code: "TT", name: "Tổ trưởng sản xuất", grade: 5 },
  { code: "QD", name: "Quản đốc phân xưởng", grade: 7 },
  { code: "NV1", name: "Nhân viên", grade: 2 },
  { code: "NV2", name: "Nhân viên chính", grade: 3 },
  { code: "CV1", name: "Chuyên viên", grade: 4 },
  { code: "CV2", name: "Chuyên viên chính", grade: 5 },
  { code: "TN", name: "Trưởng nhóm", grade: 6 },
  { code: "PQD", name: "Phó quản đốc", grade: 6 },
  { code: "PP", name: "Phó phòng", grade: 7 },
  { code: "TP", name: "Trưởng phòng", grade: 8 },
  { code: "GDK", name: "Giám đốc khối", grade: 9 },
  { code: "PTGD", name: "Phó Tổng giám đốc", grade: 10 },
  { code: "TGD", name: "Tổng giám đốc", grade: 10 },
];

const STAFF_TITLES: Record<UnitKind, string[]> = {
  PROD: ["CN1", "CN1", "CN2", "CN2", "CN3", "KTV", "KTVC"],
  OFFICE: ["NV1", "NV1", "NV2", "CV1", "CV1", "CV2"],
};
const LEAD_TITLE: Record<UnitKind, string> = { PROD: "TT", OFFICE: "TN" };
const HEAD_TITLE: Record<UnitKind, string> = { PROD: "QD", OFFICE: "TP" };
const DEPUTY_TITLE: Record<UnitKind, string> = { PROD: "PQD", OFFICE: "PP" };
const DEPUTY_MIN_HEADCOUNT = 80;
const VICE_CHIEFS = 2;
const SPAN_OF_CONTROL = 11;

// The range a grade pays; seniority decides where inside it somebody sits.
const BANDS: Record<number, [number, number]> = {
  1: [5_600_000, 7_200_000],
  2: [7_000_000, 9_400_000],
  3: [9_000_000, 12_600_000],
  4: [12_000_000, 17_500_000],
  5: [17_000_000, 24_000_000],
  6: [23_000_000, 34_000_000],
  7: [33_000_000, 48_000_000],
  8: [46_000_000, 68_000_000],
  9: [66_000_000, 108_000_000],
  10: [105_000_000, 210_000_000],
};

// Insurance is charged on a figure many employers hold below base pay, and the
// gap is what makes the D02-LT export worth reading (KEHOACH 9.19).
const INSURABLE_SHARE = 0.78;

interface AllowanceRule {
  code: string;
  label: string;
  amount: number;
  taxable: boolean;
  insurable: boolean;
  fromGrade: number;
  kind?: UnitKind;
}

const ALLOWANCES: AllowanceRule[] = [
  { code: "LUNCH", label: "Phụ cấp ăn ca", amount: 730_000, taxable: false, insurable: false, fromGrade: 1 },
  { code: "FUEL", label: "Phụ cấp xăng xe", amount: 500_000, taxable: true, insurable: false, fromGrade: 1 },
  { code: "SHIFT", label: "Phụ cấp ca kíp", amount: 600_000, taxable: true, insurable: false, fromGrade: 1, kind: "PROD" },
  { code: "PHONE", label: "Phụ cấp điện thoại", amount: 300_000, taxable: true, insurable: false, fromGrade: 4 },
  { code: "RESP", label: "Phụ cấp trách nhiệm", amount: 2_000_000, taxable: true, insurable: true, fromGrade: 5 },
  { code: "HOUSING", label: "Phụ cấp nhà ở", amount: 3_000_000, taxable: true, insurable: false, fromGrade: 7 },
];

interface ShiftPlan {
  name: string;
  startTime: string;
  endTime: string;
  graceMinutes: number;
  startHour: number;
  weight: number;
  kind: UnitKind;
}

const SHIFTS: ShiftPlan[] = [
  { name: "Hành chính", startTime: "08:00", endTime: "17:00", graceMinutes: 10, startHour: 8, weight: 1, kind: "OFFICE" },
  { name: "Ca sáng", startTime: "06:00", endTime: "14:00", graceMinutes: 5, startHour: 6, weight: 40, kind: "PROD" },
  { name: "Ca chiều", startTime: "14:00", endTime: "22:00", graceMinutes: 5, startHour: 14, weight: 35, kind: "PROD" },
  { name: "Ca đêm", startTime: "22:00", endTime: "06:00", graceMinutes: 5, startHour: 22, weight: 25, kind: "PROD" },
];

interface LeavePlan {
  code: string;
  name: string;
  paid: boolean;
  daysPerYear: number;
  carryOverMax: number;
  calendarDays?: boolean;
  weight: number;
}

const LEAVE_TYPES: LeavePlan[] = [
  { code: "ANNUAL", name: "Nghỉ phép năm", paid: true, daysPerYear: 12, carryOverMax: 5, weight: 58 },
  { code: "SICK", name: "Nghỉ ốm", paid: true, daysPerYear: 30, carryOverMax: 0, weight: 24 },
  { code: "UNPAID", name: "Nghỉ không lương", paid: false, daysPerYear: 0, carryOverMax: 0, weight: 10 },
  { code: "MARRIAGE", name: "Nghỉ kết hôn", paid: true, daysPerYear: 3, carryOverMax: 0, weight: 3 },
  { code: "BEREAVEMENT", name: "Nghỉ tang", paid: true, daysPerYear: 3, carryOverMax: 0, weight: 3 },
  { code: "MATERNITY", name: "Nghỉ thai sản", paid: true, daysPerYear: 180, carryOverMax: 0, calendarDays: true, weight: 2 },
];

// Statute sets the four solar dates; the two lunar ones are what 2026
// calendars publish, and HR confirms them against the resolution.
const HOLIDAYS: { date: string; name: string }[] = [
  { date: "2026-01-01", name: "Tết Dương lịch" },
  { date: "2026-02-16", name: "Tết Nguyên đán" },
  { date: "2026-02-17", name: "Tết Nguyên đán" },
  { date: "2026-02-18", name: "Tết Nguyên đán" },
  { date: "2026-02-19", name: "Tết Nguyên đán" },
  { date: "2026-02-20", name: "Tết Nguyên đán" },
  { date: "2026-04-26", name: "Giỗ Tổ Hùng Vương" },
  { date: "2026-04-30", name: "Ngày Giải phóng miền Nam" },
  { date: "2026-05-01", name: "Ngày Quốc tế Lao động" },
  { date: "2026-09-01", name: "Quốc khánh" },
  { date: "2026-09-02", name: "Quốc khánh" },
];

const SURNAMES = [
  "Nguyễn", "Trần", "Lê", "Phạm", "Hoàng", "Huỳnh", "Phan", "Vũ", "Võ", "Đặng",
  "Bùi", "Đỗ", "Hồ", "Ngô", "Dương", "Lý", "Đinh", "Trương", "Mai", "Lưu",
  "Cao", "Chu", "Hà", "Tạ", "Đoàn", "Tô", "Thái", "Lâm", "Quách", "Từ",
];
const MIDDLE_MALE = ["Văn", "Hữu", "Đức", "Quang", "Minh", "Thanh", "Bá", "Tiến", "Công", "Duy", "Gia", "Khánh", "Nhật", "Trọng", "Đình", "Mạnh", "Xuân", "Việt"];
const MIDDLE_FEMALE = ["Thị", "Ngọc", "Hồng", "Kim", "Thu", "Phương", "Thùy", "Diệu", "Bảo", "Hoài", "Lan", "Mỹ", "Quỳnh", "Thanh", "Minh", "Khánh", "Hà", "Tuyết"];
const GIVEN_MALE = [
  "An", "Bình", "Cường", "Dũng", "Đạt", "Giang", "Hải", "Hùng", "Huy", "Khoa",
  "Kiên", "Lâm", "Long", "Minh", "Nam", "Nghĩa", "Phong", "Phúc", "Quân", "Quốc",
  "Sơn", "Tài", "Tâm", "Thắng", "Thành", "Tiến", "Toàn", "Trung", "Tuấn", "Vinh",
  "Vũ", "Đức", "Hiếu", "Khang", "Lộc", "Nhân", "Bảo", "Duy", "Hoàng", "Kỳ",
];
const GIVEN_FEMALE = [
  "Anh", "Bích", "Chi", "Dung", "Duyên", "Hà", "Hạnh", "Hằng", "Hiền", "Hoa",
  "Hương", "Lan", "Linh", "Loan", "Mai", "My", "Nga", "Ngân", "Ngọc", "Nhung",
  "Oanh", "Phương", "Quyên", "Thảo", "Thu", "Thủy", "Trang", "Trâm", "Tuyết", "Vân",
  "Yến", "Diệp", "Giang", "Khánh", "Nhi", "Như", "Tiên", "Uyên", "Xuân", "Ý",
];

const BANKS = [
  "Vietcombank", "VietinBank", "BIDV", "Agribank", "Techcombank",
  "MB Bank", "ACB", "VPBank", "Sacombank", "TPBank",
];

const ASSET_KINDS = [
  { kind: "Máy tính xách tay", names: ["Dell Latitude 5450", "ThinkPad E14", "HP ProBook 450"] },
  { kind: "Điện thoại", names: ["Samsung Galaxy A55", "iPhone 15"] },
  { kind: "Máy đo", names: ["Thước cặp điện tử Mitutoyo", "Đồng hồ so 0-10mm"] },
  { kind: "Xe nâng", names: ["Xe nâng tay 2.5 tấn", "Xe nâng điện Toyota 1.5 tấn"] },
  { kind: "Bộ đàm", names: ["Motorola CP1660", "Kenwood TK-3407"] },
];

// A blank block reaches everybody; naming one is what the department column
// on the document is for.
const DOCUMENTS = [
  { code: "NQLD", kind: "POLICY" as const, title: "Nội quy lao động", block: null },
  { code: "STNV", kind: "HANDBOOK" as const, title: "Sổ tay nhân viên", block: null },
  { code: "ATLD", kind: "POLICY" as const, title: "Quy định an toàn lao động", block: "SX" },
  { code: "TB-TET", kind: "NOTICE" as const, title: "Thông báo lịch nghỉ Tết Bính Ngọ", block: null },
];
const ACK_SHARE = 0.62;

const LEAVE_REASONS = ["Việc gia đình", "Khám sức khoẻ", "Về quê", "Chăm con ốm", "Việc riêng", "Nghỉ dưỡng sức"];
const OT_REASON = "Chạy kịp đơn hàng xuất";

function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const random = rng(SEED);

function pick<T>(list: readonly T[]): T {
  return list[Math.floor(random() * list.length)];
}

function between(low: number, high: number): number {
  return Math.floor(random() * (high - low + 1)) + low;
}

function chance(probability: number): boolean {
  return random() < probability;
}

function weighted<T extends { weight: number }>(list: readonly T[]): T {
  const total = list.reduce((sum, one) => sum + one.weight, 0);
  let point = random() * total;
  for (const one of list) {
    point -= one.weight;
    if (point <= 0) {
      return one;
    }
  }
  return list[list.length - 1];
}

function roundTo(value: number, step: number): number {
  return Math.round(value / step) * step;
}

function dateOf(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day));
}

function isoDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Minutes the wall clock at `zone` runs ahead of UTC, read from the zone
 *  itself so the punch times agree with what the interface prints.
 */
function zoneOffsetMinutes(zone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(at);
  const field = (type: string): number => Number(parts.find((one) => one.type === type)?.value ?? 0);
  const wall = Date.UTC(field("year"), field("month") - 1, field("day"), field("hour"), field("minute"));
  return Math.round((wall - at.getTime()) / 60_000);
}

async function inChunks<T>(rows: T[], size: number, write: (slice: T[]) => Promise<unknown>): Promise<void> {
  for (let at = 0; at < rows.length; at += size) {
    await write(rows.slice(at, at + size));
  }
}

const env = validateEnv();
const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
});
const OFFSET_MINUTES = zoneOffsetMinutes(env.APP_TIMEZONE, dateOf(YEAR, 7, 1));
// The wall clock, not the demo calendar: a last day still ahead leaves the record open (KEHOACH 9.14).
const TODAY = localDay(new Date(), env.APP_TIMEZONE);

function stillWorks(person: { leaveDate: Date | null }): boolean {
  return person.leaveDate === null || isoDay(person.leaveDate) >= TODAY;
}

function punchAt(day: Date, hour: number, minute: number): Date {
  const wall = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hour, minute);
  return new Date(wall - OFFSET_MINUTES * 60_000);
}

async function wipe(): Promise<void> {
  // TRUNCATE CASCADE empties every table referencing one it names, whatever
  // that reference says on delete, and User points at Employee.
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "PayslipLine", "Payslip", "PayrollRun", "BonusItem", "SettlementItem",
      "RetroAdjustment", "PayslipDispute", "SalaryAdvance", "Notification",
      "NotificationPreference", "Request", "LeaveBalance", "Certificate",
      "ProfileChange", "Dependent", "CompensationAllowance", "CompensationRecord",
      "AttendanceDay", "AttendanceDay_flat", "AttendanceRecord", "ShiftAssignment",
      "DeviceEnrollment", "FaceTemplate", "BiometricConsent", "AssetTransfer",
      "Asset", "DocumentAck", "DocumentVersion", "Document", "PersonnelFile",
      "ChecklistTask", "ChecklistRun", "ApprovalDelegation", "EmploymentContract",
      "AuditLog", "PayrollPeriod"
    RESTART IDENTITY CASCADE
  `);
  // Deleting is what hands User.employeeId back as null rather than taking the
  // login with it; the tables it cascades into are empty by now.
  await prisma.$executeRawUnsafe(`DELETE FROM "Employee"`);
  await prisma.$executeRawUnsafe(
    `SELECT setval(pg_get_serial_sequence('"Employee"', 'id'), 1, false)`,
  );
  // A login opened for a demo employee outlives them as an address nobody
  // holds, and the next run mints that address again (KEHOACH 9.3).
  await prisma.user.deleteMany({
    where: { employeeId: null, email: { endsWith: `@${PERSON_EMAIL_DOMAIN}` } },
  });
}

interface OrgUnit {
  id: string;
  code: string;
  name: string;
  kind: UnitKind;
  weight: number;
  blockCode: string;
}

interface Org {
  entityId: string;
  root: string;
  blocks: Map<string, string>;
  units: OrgUnit[];
  titles: Map<string, string>;
  shifts: Map<string, string>;
  leaveTypes: Map<string, { id: string; plan: LeavePlan }>;
}

async function buildOrg(): Promise<Org> {
  const entity = await prisma.legalEntity.upsert({
    where: { code: ENTITY_CODE },
    update: { name: ENTITY_NAME, taxCode: ENTITY_TAX_CODE, address: ENTITY_ADDRESS },
    create: { code: ENTITY_CODE, name: ENTITY_NAME, taxCode: ENTITY_TAX_CODE, address: ENTITY_ADDRESS },
  });
  await prisma.department.deleteMany({});
  const root = await prisma.department.create({
    data: { legalEntityId: entity.id, code: "CTY", name: ENTITY_NAME, costCentre: "CC-000" },
  });

  const blocks = new Map<string, string>();
  const units: OrgUnit[] = [];
  for (const block of BLOCKS) {
    const row = await prisma.department.create({
      data: {
        legalEntityId: entity.id,
        code: block.code,
        name: block.name,
        parentId: root.id,
        costCentre: `CC-${block.code}`,
      },
    });
    blocks.set(block.code, row.id);
    for (const unit of block.units) {
      const child = await prisma.department.create({
        data: {
          legalEntityId: entity.id,
          code: unit.code,
          name: unit.name,
          parentId: row.id,
          costCentre: `CC-${unit.code}`,
        },
      });
      units.push({ id: child.id, code: unit.code, name: unit.name, kind: unit.kind, weight: unit.weight, blockCode: block.code });
    }
  }

  await prisma.jobTitle.deleteMany({});
  const titles = new Map<string, string>();
  for (const title of TITLES) {
    const row = await prisma.jobTitle.create({ data: { code: title.code, name: title.name, grade: title.grade } });
    titles.set(title.code, row.id);
  }

  await prisma.shift.deleteMany({});
  const shifts = new Map<string, string>();
  for (const plan of SHIFTS) {
    const row = await prisma.shift.create({
      data: { name: plan.name, startTime: plan.startTime, endTime: plan.endTime, graceMinutes: plan.graceMinutes },
    });
    shifts.set(plan.name, row.id);
  }

  await prisma.leaveType.deleteMany({});
  const leaveTypes = new Map<string, { id: string; plan: LeavePlan }>();
  for (const plan of LEAVE_TYPES) {
    const row = await prisma.leaveType.create({
      data: {
        code: plan.code,
        name: plan.name,
        paid: plan.paid,
        daysPerYear: plan.daysPerYear,
        carryOverMax: plan.carryOverMax,
        calendarDays: plan.calendarDays ?? false,
      },
    });
    leaveTypes.set(plan.code, { id: row.id, plan });
  }

  await prisma.holiday.deleteMany({});
  await prisma.holiday.createMany({
    data: HOLIDAYS.map((one) => ({ legalEntityId: entity.id, date: new Date(`${one.date}T00:00:00Z`), name: one.name })),
  });

  return { entityId: entity.id, root: root.id, blocks, units, titles, shifts, leaveTypes };
}

interface Person {
  id: number;
  code: string;
  fullName: string;
  gender: "MALE" | "FEMALE";
  unit: OrgUnit;
  titleCode: string;
  grade: number;
  hireDate: Date;
  leaveDate: Date | null;
  baseSalary: number;
  shiftName: string;
  managerId: number | null;
  doesOvertime: boolean;
}

function nameFor(gender: "MALE" | "FEMALE"): string {
  const middle = gender === "MALE" ? pick(MIDDLE_MALE) : pick(MIDDLE_FEMALE);
  const given = gender === "MALE" ? pick(GIVEN_MALE) : pick(GIVEN_FEMALE);
  return `${pick(SURNAMES)} ${middle} ${given}`;
}

function weightedIndex(weights: readonly number[]): number {
  const total = weights.reduce((sum, one) => sum + one, 0);
  let point = random() * total;
  for (let at = 0; at < weights.length; at += 1) {
    point -= weights[at];
    if (point <= 0) {
      return at;
    }
  }
  return weights.length - 1;
}

function hireDateFor(): Date {
  const years = weightedIndex(TENURE_WEIGHTS);
  const year = YEAR - years;
  const month = year === YEAR ? between(1, LAST_MONTH) : between(1, 12);
  return dateOf(year, month, between(1, daysInMonth(year, month)));
}

function salaryFor(grade: number, hireDate: Date): number {
  const [low, high] = BANDS[grade];
  const tenure = Math.min(YEAR - hireDate.getUTCFullYear(), 10) / 10;
  const span = high - low;
  const inside = low + span * (tenure * 0.55 + random() * 0.45);
  return roundTo(inside, 100_000);
}

function planHeadcount(): Map<string, number> {
  const total = BLOCKS.flatMap((block) => block.units).reduce((sum, one) => sum + one.weight, 0);
  const plan = new Map<string, number>();
  let handed = 0;
  const units = BLOCKS.flatMap((block) => block.units);
  for (const unit of units.slice(0, -1)) {
    const share = Math.round((unit.weight / total) * HEADCOUNT);
    plan.set(unit.code, share);
    handed += share;
  }
  plan.set(units[units.length - 1].code, HEADCOUNT - handed);
  return plan;
}

async function buildPeople(org: Org): Promise<Person[]> {
  const plan = planHeadcount();
  const people: Person[] = [];
  let serial = 0;

  const chief: Person = {
    id: 0,
    code: "NV00001",
    fullName: "Trần Quang Định",
    gender: "MALE",
    unit: org.units[org.units.length - 1],
    titleCode: "TGD",
    grade: 10,
    hireDate: dateOf(2015, 3, 2),
    leaveDate: null,
    baseSalary: 185_000_000,
    shiftName: "Hành chính",
    managerId: null,
    doesOvertime: false,
  };
  serial += 1;
  people.push(chief);

  const viceChiefs: Person[] = [];
  for (let at = 0; at < VICE_CHIEFS; at += 1) {
    serial += 1;
    const gender = chance(0.6) ? "MALE" : "FEMALE";
    const hireDate = dateOf(between(2015, 2019), between(1, 12), between(1, 28));
    const vice: Person = {
      id: 0,
      code: `NV${String(serial).padStart(5, "0")}`,
      fullName: nameFor(gender),
      gender,
      unit: org.units[org.units.length - 1],
      titleCode: "PTGD",
      grade: 10,
      hireDate,
      leaveDate: null,
      baseSalary: salaryFor(10, hireDate),
      shiftName: "Hành chính",
      managerId: null,
      doesOvertime: false,
    };
    viceChiefs.push(vice);
    people.push(vice);
  }

  const blockHeads = new Map<string, Person>();
  for (const block of BLOCKS) {
    serial += 1;
    const gender = chance(0.7) ? "MALE" : "FEMALE";
    const unit = org.units.find((one) => one.blockCode === block.code) as OrgUnit;
    const hireDate = dateOf(between(2015, 2021), between(1, 12), between(1, 28));
    const head: Person = {
      id: 0,
      code: `NV${String(serial).padStart(5, "0")}`,
      fullName: nameFor(gender),
      gender,
      unit,
      titleCode: "GDK",
      grade: 9,
      hireDate,
      leaveDate: null,
      baseSalary: salaryFor(9, hireDate),
      shiftName: "Hành chính",
      managerId: null,
      doesOvertime: false,
    };
    blockHeads.set(block.code, head);
    people.push(head);
  }

  const unitHeads = new Map<string, Person>();
  const unitLeads = new Map<string, Person[]>();
  for (const unit of org.units) {
    const want = plan.get(unit.code) ?? 0;
    if (want <= 0) {
      continue;
    }
    serial += 1;
    const gender = chance(unit.kind === "PROD" ? 0.72 : 0.45) ? "MALE" : "FEMALE";
    const headHire = dateOf(between(2015, 2022), between(1, 12), between(1, 28));
    const head: Person = {
      id: 0,
      code: `NV${String(serial).padStart(5, "0")}`,
      fullName: nameFor(gender),
      gender,
      unit,
      titleCode: HEAD_TITLE[unit.kind],
      grade: TITLES.find((one) => one.code === HEAD_TITLE[unit.kind])?.grade ?? 8,
      hireDate: headHire,
      leaveDate: null,
      baseSalary: salaryFor(TITLES.find((one) => one.code === HEAD_TITLE[unit.kind])?.grade ?? 8, headHire),
      shiftName: "Hành chính",
      managerId: null,
      doesOvertime: false,
    };
    unitHeads.set(unit.code, head);
    people.push(head);

    if (want >= DEPUTY_MIN_HEADCOUNT) {
      serial += 1;
      const deputyGender = chance(0.55) ? "MALE" : "FEMALE";
      const deputyHire = hireDateFor();
      const deputyGrade = TITLES.find((one) => one.code === DEPUTY_TITLE[unit.kind])?.grade ?? 6;
      const deputy: Person = {
        id: 0,
        code: `NV${String(serial).padStart(5, "0")}`,
        fullName: nameFor(deputyGender),
        gender: deputyGender,
        unit,
        titleCode: DEPUTY_TITLE[unit.kind],
        grade: deputyGrade,
        hireDate: deputyHire,
        leaveDate: null,
        baseSalary: salaryFor(deputyGrade, deputyHire),
        shiftName: "Hành chính",
        managerId: null,
        doesOvertime: false,
      };
      people.push(deputy);
    }

    const leadCount = Math.max(1, Math.round((want - 1) / SPAN_OF_CONTROL));
    const leads: Person[] = [];
    for (let at = 0; at < leadCount && people.length < HEADCOUNT; at += 1) {
      serial += 1;
      const leadGender = chance(unit.kind === "PROD" ? 0.6 : 0.4) ? "MALE" : "FEMALE";
      const leadHire = hireDateFor();
      const grade = TITLES.find((one) => one.code === LEAD_TITLE[unit.kind])?.grade ?? 5;
      const lead: Person = {
        id: 0,
        code: `NV${String(serial).padStart(5, "0")}`,
        fullName: nameFor(leadGender),
        gender: leadGender,
        unit,
        titleCode: LEAD_TITLE[unit.kind],
        grade,
        hireDate: leadHire,
        leaveDate: null,
        baseSalary: salaryFor(grade, leadHire),
        shiftName: unit.kind === "PROD" ? weighted(SHIFTS.filter((one) => one.kind === "PROD")).name : "Hành chính",
        managerId: null,
        doesOvertime: chance(OT_WORKER_SHARE),
      };
      leads.push(lead);
      people.push(lead);
    }
    unitLeads.set(unit.code, leads);
  }

  for (const unit of org.units) {
    const want = plan.get(unit.code) ?? 0;
    const already = 1 + (unitLeads.get(unit.code)?.length ?? 0);
    for (let at = already; at < want && people.length < HEADCOUNT; at += 1) {
      serial += 1;
      const gender = chance(unit.kind === "PROD" ? 0.52 : 0.4) ? "MALE" : "FEMALE";
      const hireDate = hireDateFor();
      const titleCode = pick(STAFF_TITLES[unit.kind]);
      const grade = TITLES.find((one) => one.code === titleCode)?.grade ?? 1;
      people.push({
        id: 0,
        code: `NV${String(serial).padStart(5, "0")}`,
        fullName: nameFor(gender),
        gender,
        unit,
        titleCode,
        grade,
        hireDate,
        leaveDate: null,
        baseSalary: salaryFor(grade, hireDate),
        shiftName: unit.kind === "PROD" ? weighted(SHIFTS.filter((one) => one.kind === "PROD")).name : "Hành chính",
        managerId: null,
        doesOvertime: unit.kind === "PROD" ? chance(OT_WORKER_SHARE * 1.8) : chance(OT_WORKER_SHARE * 0.4),
      });
    }
  }

  for (const person of people) {
    if (person.titleCode === "TGD" || person.grade >= 9) {
      continue;
    }
    // A leaver keeps their record and loses their login, which is the split
    // the schema draws (KEHOACH 9.3).
    if (chance(LEAVER_SHARE) && person.hireDate.getUTCFullYear() < YEAR) {
      const month = between(1, LAST_MONTH);
      person.leaveDate = dateOf(YEAR, month, between(1, daysInMonth(YEAR, month)));
    }
  }

  const rows: Prisma.EmployeeCreateManyInput[] = people.map((person, index) => ({
    code: person.code,
    fullName: person.fullName,
    legalEntityId: org.entityId,
    departmentId: person.unit.id,
    jobTitleId: org.titles.get(person.titleCode),
    hireDate: person.hireDate,
    leaveDate: person.leaveDate,
    dateOfBirth: dateOf(between(1968, 2006), between(1, 12), between(1, 28)),
    gender: person.gender,
    personalEmail: `nv${String(index + 1).padStart(5, "0")}@${PERSON_EMAIL_DOMAIN}`,
    phone: `09${between(10_000_000, 89_999_999)}`,
    nationalId: String(between(1, 9)) + String(between(10_000_000_000, 99_999_999_999)),
    taxCode: String(between(8_000_000_000, 8_999_999_999)),
    socialInsuranceNo: `79${between(10_000_000, 99_999_999)}`,
    bankAccount: String(between(1_000_000_000, 9_999_999_999)),
    bankName: pick(BANKS),
    active: stillWorks(person),
  }));
  await inChunks(rows, WRITE_CHUNK, (slice) => prisma.employee.createMany({ data: slice }));

  const written = await prisma.employee.findMany({ select: { id: true, code: true } });
  const idOf = new Map(written.map((one) => [one.code, one.id]));
  for (const person of people) {
    person.id = idOf.get(person.code) ?? 0;
  }

  const headOf = new Map<string, number>();
  for (const [code, head] of unitHeads) {
    headOf.set(code, head.id);
  }
  const blockOrder = [...blockHeads.keys()];
  for (const person of people) {
    if (person.titleCode === "TGD") {
      continue;
    }
    if (person.titleCode === "PTGD") {
      person.managerId = chief.id;
      continue;
    }
    if (person.titleCode === "GDK") {
      const at = blockOrder.indexOf(person.unit.blockCode);
      person.managerId = viceChiefs[Math.max(at, 0) % viceChiefs.length]?.id ?? chief.id;
      continue;
    }
    const head = unitHeads.get(person.unit.code);
    if (person.titleCode === HEAD_TITLE[person.unit.kind]) {
      person.managerId = blockHeads.get(person.unit.blockCode)?.id ?? chief.id;
      continue;
    }
    if (person.titleCode === DEPUTY_TITLE[person.unit.kind] || person.titleCode === LEAD_TITLE[person.unit.kind]) {
      person.managerId = head?.id ?? chief.id;
      continue;
    }
    const leads = unitLeads.get(person.unit.code) ?? [];
    person.managerId = leads.length > 0 ? pick(leads).id : (head?.id ?? chief.id);
  }

  await inChunks(
    people.filter((one) => one.managerId !== null),
    PEOPLE_CHUNK,
    async (slice) => {
      await prisma.$transaction(
        slice.map((one) =>
          prisma.employee.update({ where: { id: one.id }, data: { managerId: one.managerId } }),
        ),
      );
    },
  );

  for (const [code, head] of unitHeads) {
    const unit = org.units.find((one) => one.code === code);
    if (unit) {
      await prisma.department.update({ where: { id: unit.id }, data: { headId: head.id } });
    }
  }
  for (const [code, head] of blockHeads) {
    const id = org.blocks.get(code);
    if (id) {
      await prisma.department.update({ where: { id }, data: { headId: head.id } });
    }
  }
  await prisma.department.update({ where: { id: org.root }, data: { headId: chief.id } });

  return people;
}

async function buildContracts(people: Person[]): Promise<void> {
  const rows: Prisma.EmploymentContractCreateManyInput[] = [];
  for (const person of people) {
    const months = (YEAR - person.hireDate.getUTCFullYear()) * 12 + (LAST_MONTH - (person.hireDate.getUTCMonth() + 1));
    const probationEnd = new Date(person.hireDate);
    probationEnd.setUTCMonth(probationEnd.getUTCMonth() + 2);
    if (months < 2) {
      rows.push({
        employeeId: person.id,
        kind: "PROBATION",
        state: "ACTIVE",
        number: `HDTV-${person.code}`,
        startDate: person.hireDate,
        endDate: probationEnd,
        probationEnd,
        signedAt: person.hireDate,
      });
      continue;
    }
    const firstEnd = new Date(person.hireDate);
    firstEnd.setUTCFullYear(firstEnd.getUTCFullYear() + 1);
    const ended = !stillWorks(person);
    rows.push({
      employeeId: person.id,
      kind: "FIXED_TERM",
      state: months < 12 ? (ended ? "TERMINATED" : "ACTIVE") : "ENDED",
      number: `HDXD-${person.code}`,
      startDate: person.hireDate,
      endDate: firstEnd,
      probationEnd,
      signedAt: person.hireDate,
    });
    if (months >= 12) {
      rows.push({
        employeeId: person.id,
        kind: "INDEFINITE",
        state: ended ? "TERMINATED" : "ACTIVE",
        number: `HDKXD-${person.code}`,
        startDate: firstEnd,
        endDate: null,
        signedAt: firstEnd,
      });
    }
  }
  await inChunks(rows, WRITE_CHUNK, (slice) => prisma.employmentContract.createMany({ data: slice }));
}

async function buildPay(people: Person[]): Promise<Map<number, string>> {
  const records: Prisma.CompensationRecordCreateManyInput[] = [];
  const growth: Map<number, { from: Date; base: number; reason: Prisma.EnumPayReasonFieldUpdateOperationsInput["set"] }[]> = new Map();

  for (const person of people) {
    const steps: { from: Date; base: number; reason: "HIRE" | "ANNUAL_REVIEW" | "PROMOTION" }[] = [];
    const startYear = person.hireDate.getUTCFullYear();
    // A raise appends a row, so March pay recomputed in December still reads
    // March's figure (KEHOACH 9.6).
    let base = roundTo(person.baseSalary / Math.pow(1.07, YEAR - startYear), 100_000);
    steps.push({ from: person.hireDate, base, reason: "HIRE" });
    for (let year = startYear + 1; year <= YEAR; year += 1) {
      const promoted = chance(0.12);
      base = roundTo(base * (promoted ? between(112, 125) / 100 : between(104, 110) / 100), 100_000);
      if (year === YEAR) {
        base = person.baseSalary;
      }
      steps.push({ from: dateOf(year, 1, 1), base, reason: promoted ? "PROMOTION" : "ANNUAL_REVIEW" });
    }
    growth.set(person.id, steps);
    for (const step of steps) {
      records.push({
        employeeId: person.id,
        effectiveFrom: step.from,
        baseSalary: String(step.base),
        insuranceSalary: String(roundTo(step.base * INSURABLE_SHARE, 100_000)),
        reason: step.reason,
      });
    }
  }
  await inChunks(records, WRITE_CHUNK, (slice) => prisma.compensationRecord.createMany({ data: slice }));

  const current = await prisma.$queryRaw<{ employeeId: number; id: string }[]>`
    SELECT DISTINCT ON ("employeeId") "employeeId", "id"
      FROM "CompensationRecord"
     ORDER BY "employeeId", "effectiveFrom" DESC
  `;
  const latest = new Map(current.map((one) => [one.employeeId, one.id]));

  const allowances: Prisma.CompensationAllowanceCreateManyInput[] = [];
  for (const person of people) {
    const recordId = latest.get(person.id);
    if (!recordId) {
      continue;
    }
    for (const rule of ALLOWANCES) {
      if (person.grade < rule.fromGrade) {
        continue;
      }
      if (rule.kind && rule.kind !== person.unit.kind) {
        continue;
      }
      allowances.push({
        recordId,
        code: rule.code,
        label: rule.label,
        amount: String(rule.amount),
        taxable: rule.taxable,
        insurable: rule.insurable,
      });
    }
  }
  await inChunks(allowances, WRITE_CHUNK, (slice) => prisma.compensationAllowance.createMany({ data: slice }));
  return latest;
}

async function buildSideRecords(org: Org, people: Person[]): Promise<void> {
  const shiftRows: Prisma.ShiftAssignmentCreateManyInput[] = people.map((person) => ({
    shiftId: org.shifts.get(person.shiftName) as string,
    employeeId: person.id,
    validFrom: person.hireDate,
    validTo: person.leaveDate,
  }));
  await inChunks(shiftRows, WRITE_CHUNK, (slice) => prisma.shiftAssignment.createMany({ data: slice }));

  const annual = org.leaveTypes.get("ANNUAL");
  const balances: Prisma.LeaveBalanceCreateManyInput[] = [];
  const dependents: Prisma.DependentCreateManyInput[] = [];
  const consents: Prisma.BiometricConsentCreateManyInput[] = [];
  for (const person of people) {
    if (annual) {
      const seniority = Math.floor((YEAR - person.hireDate.getUTCFullYear()) / 5);
      balances.push({
        employeeId: person.id,
        leaveTypeId: annual.id,
        year: YEAR,
        entitled: annual.plan.daysPerYear + seniority,
        carriedOver: person.hireDate.getUTCFullYear() < YEAR ? between(0, annual.plan.carryOverMax) : 0,
      });
    }
    if (chance(DEPENDENT_SHARE)) {
      const count = chance(0.35) ? 2 : 1;
      for (let at = 0; at < count; at += 1) {
        const born = between(2010, 2025);
        dependents.push({
          employeeId: person.id,
          fullName: nameFor(chance(0.5) ? "MALE" : "FEMALE"),
          relation: "CHILD",
          dateOfBirth: dateOf(born, between(1, 12), between(1, 28)),
          fromMonth: dateOf(Math.max(born, person.hireDate.getUTCFullYear()), 1, 1),
          state: "ACTIVE",
        });
      }
    }
    if (stillWorks(person)) {
      consents.push({
        employeeId: person.id,
        noticeVersion: env.BIOMETRIC_NOTICE_VERSION,
        method: person.unit.kind === "PROD" ? "KIOSK" : "PORTAL",
        state: "GRANTED",
        grantedAt: person.hireDate,
      });
    }
  }
  await inChunks(balances, WRITE_CHUNK, (slice) => prisma.leaveBalance.createMany({ data: slice }));
  await inChunks(dependents, WRITE_CHUNK, (slice) => prisma.dependent.createMany({ data: slice }));
  await inChunks(consents, WRITE_CHUNK, (slice) => prisma.biometricConsent.createMany({ data: slice }));
}

async function buildDevices(): Promise<Map<UnitKind, string[]>> {
  const byKind = new Map<UnitKind, string[]>([
    ["PROD", []],
    ["OFFICE", []],
  ]);
  for (const kiosk of DEVICES) {
    await prisma.device.upsert({
      where: { id: kiosk.id },
      update: { name: kiosk.name, location: kiosk.location, status: "APPROVED" },
      create: {
        id: kiosk.id,
        name: kiosk.name,
        location: kiosk.location,
        status: "APPROVED",
        approvedAt: dateOf(YEAR, 1, 2),
        lastSeenAt: dateOf(YEAR, LAST_MONTH, DESK_WINDOW_DAY),
        online: true,
      },
    });
    byKind.get(kiosk.kind)?.push(kiosk.id);
  }
  // One kiosk still asking to be let in, because that queue is a screen.
  await prisma.device.upsert({
    where: { id: PENDING_DEVICE.id },
    update: { status: "PENDING" },
    create: { id: PENDING_DEVICE.id, name: PENDING_DEVICE.name, location: PENDING_DEVICE.location },
  });
  return byKind;
}

interface DayPlan {
  date: Date;
  state: "WORKED" | "LEAVE" | "HOLIDAY" | "ABSENT" | "WEEKEND";
  overtimeMinutes: number;
  leaveCode: string | null;
}

function holidaySet(): Set<string> {
  return new Set(HOLIDAYS.map((one) => one.date));
}

/** A month of one person's calendar. The week runs Monday to Saturday, which
 *  is what the policy's standard day count is written against (KEHOACH 9.7).
 */
function planMonth(person: Person, month: number, holidays: Set<string>): DayPlan[] {
  const plan: DayPlan[] = [];
  const total = daysInMonth(YEAR, month);
  let leaveLeft = 0;
  let leaveCode = "ANNUAL";
  for (let day = 1; day <= total; day += 1) {
    const at = dateOf(YEAR, month, day);
    if (at < person.hireDate || (person.leaveDate !== null && at > person.leaveDate)) {
      continue;
    }
    if (at.getUTCDay() === 0) {
      if (person.doesOvertime && person.unit.kind === "PROD" && chance(SUNDAY_OT_CHANCE)) {
        plan.push({ date: at, state: "WEEKEND", overtimeMinutes: between(4, 8) * MINUTES_PER_HOUR, leaveCode: null });
      }
      continue;
    }
    if (holidays.has(isoDay(at))) {
      plan.push({ date: at, state: "HOLIDAY", overtimeMinutes: 0, leaveCode: null });
      continue;
    }
    // Nobody takes leave one scattered day at a time, so a spell runs on until
    // its days are used up.
    if (leaveLeft > 0) {
      leaveLeft -= 1;
      plan.push({ date: at, state: "LEAVE", overtimeMinutes: 0, leaveCode });
      continue;
    }
    if (chance(ABSENT_CHANCE)) {
      plan.push({ date: at, state: "ABSENT", overtimeMinutes: 0, leaveCode: null });
      continue;
    }
    if (chance(LEAVE_CHANCE)) {
      leaveCode = weighted(LEAVE_TYPES).code;
      leaveLeft = between(0, LEAVE_SPELL_MAX - 1);
      plan.push({ date: at, state: "LEAVE", overtimeMinutes: 0, leaveCode });
      continue;
    }
    const overtime = person.doesOvertime && chance(0.18) ? between(1, 3) * MINUTES_PER_HOUR : 0;
    plan.push({ date: at, state: "WORKED", overtimeMinutes: overtime, leaveCode: null });
  }
  return plan;
}

async function buildHistory(org: Org, people: Person[], kiosks: Map<UnitKind, string[]>): Promise<void> {
  const holidays = holidaySet();
  const shiftStart = new Map(SHIFTS.map((one) => [one.name, one.startHour]));
  const takenOf = new Map<number, number>();

  let serial = 0;
  for (let month = 1; month <= LAST_MONTH; month += 1) {
    const days: Prisma.AttendanceDayCreateManyInput[] = [];
    const requests: Prisma.RequestCreateManyInput[] = [];
    const punches: Prisma.AttendanceRecordCreateManyInput[] = [];
    const keepPunches = month > LAST_MONTH - PUNCH_MONTHS;
    for (const person of people) {
      const plan = planMonth(person, month, holidays);
      if (plan.length === 0) {
        continue;
      }
      const startHour = shiftStart.get(person.shiftName) ?? 8;
      const shiftId = org.shifts.get(person.shiftName);
      const doors = kiosks.get(person.unit.kind) ?? [];
      const kiosk = doors[person.id % Math.max(doors.length, 1)] ?? DEVICES[0].id;
      let spell: DayPlan[] = [];
      const flush = (): void => {
        if (spell.length === 0) {
          return;
        }
        const type = org.leaveTypes.get(spell[0].leaveCode ?? "ANNUAL");
        if (type) {
          requests.push({
            employeeId: person.id,
            kind: "LEAVE",
            state: "APPROVED",
            leaveTypeId: type.id,
            fromDate: spell[0].date,
            toDate: spell[spell.length - 1].date,
            days: spell.length,
            reason: pick(LEAVE_REASONS),
            approverId: person.managerId,
            decidedAt: spell[0].date,
          });
          if (type.plan.code === "ANNUAL") {
            takenOf.set(person.id, (takenOf.get(person.id) ?? 0) + spell.length);
          }
        }
        spell = [];
      };

      for (const day of plan) {
        if (day.state === "LEAVE") {
          if (spell.length > 0 && spell[0].leaveCode !== day.leaveCode) {
            flush();
          }
          spell.push(day);
        } else {
          flush();
        }

        if (day.overtimeMinutes > 0) {
          requests.push({
            employeeId: person.id,
            kind: "OVERTIME",
            state: "APPROVED",
            fromDate: day.date,
            toDate: day.date,
            minutes: day.overtimeMinutes,
            reason: OT_REASON,
            approverId: person.managerId,
            decidedAt: day.date,
          });
        }

        const onSite = day.state === "WORKED" || day.state === "WEEKEND";
        const late = day.state === "WORKED" && chance(LATE_CHANCE) ? between(3, 35) : 0;
        const paidBreak = day.state === "WORKED" ? BREAK_MINUTES : 0;
        const worked =
          day.state === "WORKED" ? FULL_DAY_MINUTES - late + day.overtimeMinutes : day.overtimeMinutes;
        const camein = onSite ? punchAt(day.date, startHour, late) : null;
        const wentout = onSite ? punchAt(day.date, startHour, late + worked + paidBreak) : null;
        days.push({
          employeeId: person.id,
          date: day.date,
          state: day.state,
          shiftId,
          firstIn: camein,
          lastOut: wentout,
          workedMinutes: onSite ? worked : 0,
          lateMinutes: late,
          overtimeMinutes: day.overtimeMinutes,
          punchCount: onSite ? 2 : 0,
          measuredMinutes: onSite ? worked : null,
        });

        if (keepPunches && camein && wentout) {
          for (const [at, way] of [
            [camein, "IN"],
            [wentout, "OUT"],
          ] as const) {
            serial += 1;
            punches.push({
              localId: String(serial),
              deviceId: kiosk,
              employeeId: person.id,
              ts: at,
              direction: way,
              score: between(720, 960) / 1000,
              livenessScore: between(640, 990) / 1000,
              doorOpened: true,
            });
          }
        }
      }
      flush();
    }
    await inChunks(days, WRITE_CHUNK, (slice) => prisma.attendanceDay.createMany({ data: slice }));
    await inChunks(requests, WRITE_CHUNK, (slice) => prisma.request.createMany({ data: slice }));
    await inChunks(punches, WRITE_CHUNK, (slice) => prisma.attendanceRecord.createMany({ data: slice }));
    const raw = punches.length > 0 ? `, ${punches.length} lượt quẹt` : "";
    process.stdout.write(
      `  ${YEAR}-${String(month).padStart(2, "0")}: ${days.length} ngày công, ${requests.length} đơn${raw}\n`,
    );
  }

  const annual = org.leaveTypes.get("ANNUAL");
  if (annual) {
    const updates = [...takenOf.entries()];
    await inChunks(updates, PEOPLE_CHUNK, async (slice) => {
      await prisma.$transaction(
        slice.map(([employeeId, taken]) =>
          prisma.leaveBalance.updateMany({
            where: { employeeId, leaveTypeId: annual.id, year: YEAR },
            data: { taken },
          }),
        ),
      );
    });
  }
}

async function buildPayroll(org: Org, people: Person[]): Promise<void> {
  const policies = await prisma.payrollPolicy.findMany({
    where: { legalEntityId: org.entityId },
    include: { brackets: { orderBy: { ordinal: "asc" } } },
    orderBy: { effectiveFrom: "asc" },
  });
  if (policies.length === 0) {
    throw new Error("no payroll policy: run prisma db seed first");
  }

  const alive = new Map(people.map((one) => [one.id, one]));
  for (let month = 1; month <= LAST_MONTH; month += 1) {
    const start = dateOf(YEAR, month, 1);
    const end = dateOf(YEAR, month, daysInMonth(YEAR, month));
    const open = month === LAST_MONTH;
    const period = await prisma.payrollPeriod.create({
      data: {
        legalEntityId: org.entityId,
        year: YEAR,
        month,
        state: open ? "OPEN" : "PAID",
        startDate: start,
        endDate: end,
        payDate: open ? null : dateOf(YEAR, month === 12 ? 1 : month + 1, 5),
        lockedAt: open ? null : end,
        paidAt: open ? null : dateOf(YEAR, month === 12 ? 1 : month + 1, 5),
      },
    });
    if (open) {
      continue;
    }

    const policy = policies.filter((one) => one.effectiveFrom <= end).at(-1) ?? policies[0];
    const calcPolicy = asCalcPolicy(policy);
    const run = await prisma.payrollRun.create({
      data: {
        periodId: period.id,
        kind: "REGULAR",
        state: "DONE",
        label: `Kỳ ${String(month).padStart(2, "0")}/${YEAR}`,
        startedAt: end,
        finishedAt: end,
      },
    });

    const tally = await prisma.$queryRaw<
      {
        employeeId: number;
        workedDays: number;
        holidayDays: number;
        absentDays: number;
        workedMinutes: number;
        weekdayOt: number;
        weekendOt: number;
        holidayOt: number;
      }[]
    >`
      SELECT "employeeId",
             count(*) FILTER (WHERE "state" = 'WORKED')::int  AS "workedDays",
             count(*) FILTER (WHERE "state" = 'HOLIDAY')::int AS "holidayDays",
             count(*) FILTER (WHERE "state" = 'ABSENT')::int  AS "absentDays",
             coalesce(sum("workedMinutes"), 0)::int           AS "workedMinutes",
             coalesce(sum("overtimeMinutes") FILTER (WHERE "state" = 'WORKED'), 0)::int  AS "weekdayOt",
             coalesce(sum("overtimeMinutes") FILTER (WHERE "state" = 'WEEKEND'), 0)::int AS "weekendOt",
             coalesce(sum("overtimeMinutes") FILTER (WHERE "state" = 'HOLIDAY'), 0)::int AS "holidayOt"
        FROM "AttendanceDay"
       WHERE "date" BETWEEN ${start} AND ${end}
       GROUP BY "employeeId"
    `;
    const leaveTally = await prisma.$queryRaw<{ employeeId: number; paidLeave: number; unpaidLeave: number }[]>`
      SELECT d."employeeId",
             count(*) FILTER (WHERE t."paid")::int     AS "paidLeave",
             count(*) FILTER (WHERE NOT t."paid")::int AS "unpaidLeave"
        FROM "AttendanceDay" d
        JOIN "Request" r ON r."employeeId" = d."employeeId" AND r."kind" = 'LEAVE'
                        AND r."state" = 'APPROVED' AND d."date" BETWEEN r."fromDate" AND r."toDate"
        JOIN "LeaveType" t ON t."id" = r."leaveTypeId"
       WHERE d."state" = 'LEAVE' AND d."date" BETWEEN ${start} AND ${end}
       GROUP BY d."employeeId"
    `;
    const packets = await prisma.$queryRaw<
      { employeeId: number; recordId: string; baseSalary: string; insuranceSalary: string }[]
    >`
      SELECT DISTINCT ON ("employeeId") "employeeId", "id" AS "recordId",
             "baseSalary"::text, "insuranceSalary"::text
        FROM "CompensationRecord"
       WHERE "effectiveFrom" <= ${end}
       ORDER BY "employeeId", "effectiveFrom" DESC
    `;
    const extras = await prisma.$queryRaw<
      { recordId: string; code: string; label: string; amount: string; taxable: boolean; insurable: boolean }[]
    >`
      SELECT "recordId", "code", "label", "amount"::text, "taxable", "insurable"
        FROM "CompensationAllowance"
    `;
    const dependants = await prisma.$queryRaw<{ employeeId: number; count: number }[]>`
      SELECT "employeeId", count(*)::int AS "count"
        FROM "Dependent"
       WHERE "state" = 'ACTIVE' AND "fromMonth" <= ${end}
       GROUP BY "employeeId"
    `;

    const allowanceOf = new Map<string, CalcAllowance[]>();
    for (const row of extras) {
      const list = allowanceOf.get(row.recordId) ?? [];
      list.push({
        code: row.code,
        label: row.label,
        amount: BigInt(row.amount.split(".")[0]),
        taxable: row.taxable,
        insurable: row.insurable,
      });
      allowanceOf.set(row.recordId, list);
    }
    const dayOf = new Map(tally.map((one) => [one.employeeId, one]));
    const offOf = new Map(leaveTally.map((one) => [one.employeeId, one]));
    const dependentOf = new Map(dependants.map((one) => [one.employeeId, one.count]));

    const slips: Prisma.PayslipCreateManyInput[] = [];
    const linesOf = new Map<number, ReturnType<typeof calculate>["lines"]>();
    let gross = 0n;
    let net = 0n;
    for (const packet of packets) {
      const person = alive.get(packet.employeeId);
      const day = dayOf.get(packet.employeeId);
      if (!person || !day || day.workedDays + day.holidayDays === 0) {
        continue;
      }
      const off = offOf.get(packet.employeeId);
      const paidLeave = off?.paidLeave ?? 0;
      const unpaid = (off?.unpaidLeave ?? 0) + day.absentDays;
      const result = calculate({
        policy: calcPolicy,
        baseSalary: BigInt(packet.baseSalary.split(".")[0]),
        insuranceSalary: BigInt(packet.insuranceSalary.split(".")[0]),
        allowances: allowanceOf.get(packet.recordId) ?? [],
        dependentCount: dependentOf.get(packet.employeeId) ?? 0,
        paidDayHundredths: BigInt(day.workedDays + day.holidayDays + paidLeave) * 100n,
        unpaidDayHundredths: BigInt(unpaid) * 100n,
        overtime: {
          weekdayMinutes: day.weekdayOt,
          weekendMinutes: day.weekendOt,
          holidayMinutes: day.holidayOt,
          nightMinutes: 0,
        },
        extras: [],
        deductions: [],
      });
      linesOf.set(packet.employeeId, result.lines);
      gross += result.grossPay;
      net += result.netPay;
      slips.push({
        runId: run.id,
        periodId: period.id,
        employeeId: packet.employeeId,
        policyId: policy.id,
        state: chance(0.6) ? "VIEWED" : "SENT",
        workedDays: day.workedDays,
        paidLeaveDays: paidLeave,
        unpaidDays: unpaid,
        workedMinutes: day.workedMinutes,
        overtimeMinutes: day.weekdayOt + day.weekendOt + day.holidayOt,
        grossPay: result.grossPay.toString(),
        taxableIncome: result.taxableIncome.toString(),
        insuranceEmployee: result.insuranceEmployee.toString(),
        insuranceEmployer: result.insuranceEmployer.toString(),
        personalIncomeTax: result.personalIncomeTax.toString(),
        deductionsTotal: result.deductionsTotal.toString(),
        netPay: result.netPay.toString(),
        bankName: person.shiftName === "" ? null : pick(BANKS),
        issuedAt: end,
        sentAt: end,
      });
    }
    await inChunks(slips, WRITE_CHUNK, (slice) => prisma.payslip.createMany({ data: slice }));

    const written = await prisma.payslip.findMany({
      where: { runId: run.id },
      select: { id: true, employeeId: true },
    });
    const lines: Prisma.PayslipLineCreateManyInput[] = [];
    for (const slip of written) {
      const own = linesOf.get(slip.employeeId) ?? [];
      for (const [index, line] of own.entries()) {
        lines.push({
          payslipId: slip.id,
          ordinal: index + 1,
          kind: line.kind,
          code: line.code,
          label: line.label ?? null,
          amount: line.amount.toString(),
          quantity: line.quantity ?? null,
          rateBp: line.rateBp ?? null,
        });
      }
    }
    await inChunks(lines, WRITE_CHUNK, (slice) => prisma.payslipLine.createMany({ data: slice }));
    await prisma.payrollRun.update({
      where: { id: run.id },
      data: {
        employeeCount: written.length,
        doneCount: written.length,
        grossTotal: gross.toString(),
        netTotal: net.toString(),
      },
    });
    process.stdout.write(`  kỳ ${String(month).padStart(2, "0")}/${YEAR}: ${written.length} phiếu, ${lines.length} dòng\n`);
  }
}

async function buildDesk(org: Org, people: Person[]): Promise<void> {
  const working = people.filter((one) => one.leaveDate === null);
  const from = dateOf(YEAR, LAST_MONTH, DESK_WINDOW_DAY);
  const to = dateOf(YEAR, LAST_MONTH, daysInMonth(YEAR, LAST_MONTH));
  // One leave request per person per window: the database refuses two that
  // overlap, and a desk with two from one person is not what it looks like.
  const busy = await prisma.request.findMany({
    where: { kind: "LEAVE", state: { in: ["PENDING", "APPROVED"] }, fromDate: { lte: to }, toDate: { gte: from } },
    select: { employeeId: true },
  });
  const taken = new Set(busy.map((one) => one.employeeId));
  const waiting: Prisma.RequestCreateManyInput[] = [];
  for (let tries = 0; tries < DESK_REQUESTS * 20 && waiting.length < DESK_REQUESTS; tries += 1) {
    const person = pick(working);
    if (taken.has(person.id)) {
      continue;
    }
    taken.add(person.id);
    const day = between(DESK_WINDOW_DAY, daysInMonth(YEAR, LAST_MONTH) - 2);
    const span = between(0, 2);
    waiting.push({
      employeeId: person.id,
      kind: "LEAVE",
      state: "PENDING",
      leaveTypeId: org.leaveTypes.get(weighted(LEAVE_TYPES).code)?.id,
      fromDate: dateOf(YEAR, LAST_MONTH, day),
      toDate: dateOf(YEAR, LAST_MONTH, day + span),
      days: span + 1,
      reason: pick(LEAVE_REASONS),
      approverId: person.managerId,
    });
  }
  await prisma.request.createMany({ data: waiting });

  const advances: Prisma.SalaryAdvanceCreateManyInput[] = [];
  for (let at = 0; at < DESK_ADVANCES; at += 1) {
    const person = pick(working);
    advances.push({
      employeeId: person.id,
      amount: String(roundTo(person.baseSalary * (between(20, 45) / 100), 500_000)),
      reason: pick(["Việc gia đình", "Chi phí y tế", "Sửa nhà", "Học phí cho con"]),
      state: at < 6 ? "PENDING" : "PAID",
    });
  }
  await prisma.salaryAdvance.createMany({ data: advances });

  const assets: Prisma.AssetCreateManyInput[] = [];
  let serial = 0;
  for (const group of ASSET_KINDS) {
    for (let at = 0; at < ASSETS_PER_KIND; at += 1) {
      serial += 1;
      const held = chance(0.7);
      const holder = held ? pick(working) : null;
      assets.push({
        code: `TS${String(serial).padStart(4, "0")}`,
        name: pick(group.names),
        kind: group.kind,
        serialNo: `SN${between(100_000, 999_999)}`,
        state: held ? "ISSUED" : "IN_STOCK",
        holderId: holder?.id ?? null,
      });
    }
  }
  await prisma.asset.createMany({ data: assets });

  for (const doc of DOCUMENTS) {
    const row = await prisma.document.create({
      data: {
        code: doc.code,
        kind: doc.kind,
        title: doc.title,
        departmentId: doc.block === null ? null : org.blocks.get(doc.block),
      },
    });
    const version = await prisma.documentVersion.create({
      data: {
        documentId: row.id,
        version: 1,
        body: `${doc.title} — bản hiệu lực từ ngày 01/01/${YEAR}.`,
        publishedAt: dateOf(YEAR, 1, 1),
      },
    });
    const readers = working.filter((one) => doc.block === null || one.unit.blockCode === doc.block);
    const acks: Prisma.DocumentAckCreateManyInput[] = readers
      .filter(() => chance(ACK_SHARE))
      .map((one) => ({ versionId: version.id, employeeId: one.id, ackAt: dateOf(YEAR, between(1, LAST_MONTH), between(1, 28)) }));
    await inChunks(acks, WRITE_CHUNK, (slice) => prisma.documentAck.createMany({ data: slice }));
  }
}

async function relinkLogins(people: Person[]): Promise<void> {
  const byTitle = (code: string, unit?: string): Person | undefined =>
    people.find((one) => one.titleCode === code && one.leaveDate === null && (!unit || one.unit.code === unit));

  const desks: { email: string; person: Person | undefined }[] = [
    { email: "hr@kiosk.local", person: byTitle("TP", "NS-TD") },
    { email: "payroll@kiosk.local", person: byTitle("TP", "NS-CB") },
    { email: "manager@kiosk.local", person: byTitle("QD", "SX-LR1") },
    { email: "employee@kiosk.local", person: people.find((one) => one.unit.code === "SX-LR1" && one.titleCode.startsWith("CN") && one.leaveDate === null) },
  ];
  for (const desk of desks) {
    if (!desk.person) {
      throw new Error(`no demo employee to stand behind ${desk.email}`);
    }
    const touched = await prisma.user.updateMany({
      where: { email: desk.email },
      data: { employeeId: desk.person.id },
    });
    if (touched.count === 0) {
      throw new Error(`${desk.email} has no login: run prisma db seed first`);
    }
    process.stdout.write(`  ${desk.email} → ${desk.person.code} ${desk.person.fullName}\n`);
  }
}

async function main(): Promise<void> {
  const began = Date.now();
  process.stdout.write("dọn dữ liệu cũ\n");
  await wipe();

  process.stdout.write("dựng tổ chức\n");
  const org = await buildOrg();

  process.stdout.write(`dựng ${HEADCOUNT} hồ sơ nhân sự\n`);
  const people = await buildPeople(org);

  process.stdout.write("hợp đồng lao động\n");
  await buildContracts(people);

  process.stdout.write("thang lương và phụ cấp\n");
  await buildPay(people);

  process.stdout.write("ca, phép, người phụ thuộc, đồng ý sinh trắc\n");
  await buildSideRecords(org, people);

  process.stdout.write("kiosk chấm công\n");
  const kiosks = await buildDevices();

  process.stdout.write(`chấm công và đơn từ ${YEAR}-01 tới ${YEAR}-${String(LAST_MONTH).padStart(2, "0")}\n`);
  await buildHistory(org, people, kiosks);

  process.stdout.write("kỳ lương và phiếu lương\n");
  await buildPayroll(org, people);

  process.stdout.write("việc đang chờ trên bàn\n");
  await buildDesk(org, people);

  process.stdout.write("nối lại tài khoản đăng nhập\n");
  await relinkLogins(people);

  const seconds = ((Date.now() - began) / 1000).toFixed(1);
  process.stdout.write(`xong trong ${seconds}s\n`);
}

main()
  .catch((fell: unknown) => {
    process.stderr.write(`${String(fell)}\n`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
