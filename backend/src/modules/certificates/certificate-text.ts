import type { CertificateKind } from "@prisma/client";

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
  entity: string;
  hireDate: string | null;
  contract: string | null;
  purpose: string;
  earnings: Earnings[];
}

const HEAD = [
  "CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM",
  "Độc lập - Tự do - Hạnh phúc",
  "---------------",
  "",
];

function about(facts: LetterFacts): string[] {
  return [
    `Họ và tên: ${facts.fullName}`,
    `Mã nhân viên: ${facts.code}`,
    ...(facts.dateOfBirth ? [`Ngày sinh: ${facts.dateOfBirth}`] : []),
    ...(facts.nationalId ? [`Số CCCD: ${facts.nationalId}`] : []),
    ...(facts.jobTitle ? [`Chức danh: ${facts.jobTitle}`] : []),
    ...(facts.department ? [`Bộ phận: ${facts.department}`] : []),
    ...(facts.hireDate ? [`Ngày vào làm: ${facts.hireDate}`] : []),
    ...(facts.contract ? [`Loại hợp đồng: ${facts.contract}`] : []),
  ];
}

/** The wording of a letter somebody takes to a bank, so it is written here
 *  rather than in either client catalogue (KEHOACH 3.1).
 */
export function letterFor(kind: CertificateKind, facts: LetterFacts): string {
  const title = kind === "INCOME" ? "GIẤY XÁC NHẬN THU NHẬP" : "GIẤY XÁC NHẬN CÔNG TÁC";
  const earnings =
    kind === "INCOME"
      ? [
          "",
          "Thu nhập thực nhận các kỳ gần nhất:",
          ...facts.earnings.map((one) => `  ${one.month}/${one.year}: ${one.net} VND`),
          ...(facts.earnings.length === 0 ? ["  (chưa có kỳ lương nào đã phát)"] : []),
        ]
      : [];
  return [
    ...HEAD,
    title,
    `Số: ${facts.serial}`,
    "",
    `${facts.entity} xác nhận:`,
    "",
    ...about(facts),
    ...earnings,
    "",
    `Giấy này được cấp theo đề nghị của người lao động, dùng cho mục đích: ${facts.purpose}.`,
    "",
    `Ngày cấp: ${facts.issuedOn}`,
    "",
    "NGƯỜI ĐẠI DIỆN",
    "(ký, ghi rõ họ tên và đóng dấu)",
  ].join("\n");
}
