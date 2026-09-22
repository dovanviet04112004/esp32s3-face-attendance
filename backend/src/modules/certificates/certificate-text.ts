import type { CertificateKind, ContractKind } from "@prisma/client";

export interface Earnings {
  year: number;
  month: number;
  net: string;
}

export interface LetterFacts {
  serial: string;
  issuedOn: string;
  fullName: string;
  code: string;
  dateOfBirth: string | null;
  nationalId: string | null;
  jobTitle: string | null;
  department: string | null;
  entity: string | null;
  hireDate: string | null;
  contract: ContractKind | null;
  purpose: string;
  earnings: Earnings[];
}

type Said = readonly [vi: string, en: string];

// The reader is whoever the holder hands it to: a bank, a landlord, a
// consulate. Both languages on one page rather than two documents.
const HEAD: Said[] = [
  ["CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM", "SOCIALIST REPUBLIC OF VIETNAM"],
  ["Độc lập - Tự do - Hạnh phúc", "Independence - Freedom - Happiness"],
];

const TITLE: Record<CertificateKind, Said> = {
  EMPLOYMENT: ["GIẤY XÁC NHẬN CÔNG TÁC", "CERTIFICATE OF EMPLOYMENT"],
  INCOME: ["GIẤY XÁC NHẬN THU NHẬP", "CERTIFICATE OF INCOME"],
};

const CONTRACT: Record<ContractKind, Said> = {
  PROBATION: ["Thử việc", "Probation"],
  FIXED_TERM: ["Xác định thời hạn", "Fixed term"],
  INDEFINITE: ["Không xác định thời hạn", "Indefinite term"],
  SEASONAL: ["Theo mùa vụ", "Seasonal"],
  INTERNSHIP: ["Thực tập", "Internship"],
};

const FALLBACK_ENTITY: Said = ["Công ty", "The company"];

function stacked(said: Said): string[] {
  return [said[0], said[1]];
}

function field(said: Said, value: string): string {
  return `${said[0]} / ${said[1]}: ${value}`;
}

function both(said: Said): string {
  return `${said[0]} / ${said[1]}`;
}

function about(facts: LetterFacts): string[] {
  return [
    field(["Họ và tên", "Full name"], facts.fullName),
    field(["Mã nhân viên", "Employee ID"], facts.code),
    ...(facts.dateOfBirth ? [field(["Ngày sinh", "Date of birth"], facts.dateOfBirth)] : []),
    ...(facts.nationalId ? [field(["Số CCCD", "ID number"], facts.nationalId)] : []),
    ...(facts.jobTitle ? [field(["Chức danh", "Job title"], facts.jobTitle)] : []),
    ...(facts.department ? [field(["Bộ phận", "Department"], facts.department)] : []),
    ...(facts.hireDate ? [field(["Ngày vào làm", "Start date"], facts.hireDate)] : []),
    ...(facts.contract
      ? [field(["Loại hợp đồng", "Contract type"], both(CONTRACT[facts.contract]))]
      : []),
  ];
}

function earningsOf(facts: LetterFacts): string[] {
  const lines = facts.earnings.map((one) => `  ${one.month}/${one.year}: ${one.net} VND`);
  return [
    "",
    both(["Thu nhập thực nhận các kỳ gần nhất", "Net pay for the most recent periods"]),
    ...(lines.length > 0
      ? lines
      : [`  ${both(["(chưa có kỳ lương nào đã phát)", "(no payslip issued yet)"])}`]),
  ];
}

/** The wording of a letter somebody takes to a bank, so it is written here
 *  rather than in either client catalogue (KEHOACH 3.1).
 */
export function letterFor(kind: CertificateKind, facts: LetterFacts): string {
  const entity = facts.entity ?? both(FALLBACK_ENTITY);
  return [
    ...HEAD.flatMap(stacked),
    "---------------",
    "",
    ...stacked(TITLE[kind]),
    field(["Số", "No"], facts.serial),
    "",
    `${entity} ${both(["xác nhận", "certifies that"])}:`,
    "",
    ...about(facts),
    ...(kind === "INCOME" ? earningsOf(facts) : []),
    "",
    `Giấy này được cấp theo đề nghị của người lao động, dùng cho mục đích: ${facts.purpose}.`,
    `Issued at the employee's request for the following purpose: ${facts.purpose}.`,
    "",
    field(["Ngày cấp", "Issued on"], facts.issuedOn),
    "",
    both(["NGƯỜI ĐẠI DIỆN", "FOR AND ON BEHALF OF THE COMPANY"]),
    both(["(ký, ghi rõ họ tên và đóng dấu)", "(signature, full name and seal)"]),
  ].join("\n");
}
