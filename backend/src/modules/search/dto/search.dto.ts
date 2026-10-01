import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsOptional, IsString, MaxLength } from "class-validator";

export const SEARCH_TERM_MAX = 64;

export const HIT_KINDS = [
  "employee",
  "department",
  "request",
  "certificate",
  "profileChange",
  "dispute",
  "dependent",
  "advance",
  "payslip",
  "payrollPeriod",
  "kiosk",
  "asset",
  "document",
] as const;

export type HitKind = (typeof HIT_KINDS)[number];

const KIND_DOC = {
  enum: HIT_KINDS,
  enumName: "SearchHitKind",
  example: "employee",
  description:
    "Which list the hit comes from: employee, department, request (leave, overtime, attendance fix, trip, remote work), " +
    "certificate, profileChange, dispute, dependent, advance, payslip, payrollPeriod, kiosk, asset or document",
};

export class SearchQueryDto {
  @ApiPropertyOptional({
    maxLength: SEARCH_TERM_MAX,
    example: "nguyen",
    description:
      "Two characters or more; shorter answers nothing. Accents and case are folded, `%` and `_` match only themselves, " +
      "and a date (23/09, 23/09/2026, 2026-09-23) or a month (08/2026, 2026-08) is read as one",
  })
  @IsOptional()
  @IsString()
  @MaxLength(SEARCH_TERM_MAX)
  q?: string;
}

export class SearchHitView {
  @ApiProperty(KIND_DOC)
  kind!: string;

  @ApiProperty({ example: "42", description: "Id within its kind, as text; an employee's is a number" })
  id!: string;

  @ApiProperty({
    example: "Nguyễn Văn An",
    description: "The person the row is about, or the name of the department, period (MM/YYYY), kiosk, asset or document",
  })
  title!: string;

  @ApiProperty({ example: "NV0042 · Kỹ thuật", description: "Codes, days (YYYY-MM-DD) and months (MM/YYYY) only; never an amount" })
  detail!: string;

  @ApiProperty({
    example: "/employees/12",
    description: "Dashboard path that opens this very row on a page the viewer's role opens",
  })
  href!: string;

  @ApiPropertyOptional({
    enum: ["LEAVE", "OVERTIME", "ATTENDANCE_FIX", "BUSINESS_TRIP", "REMOTE_WORK"],
    enumName: "RequestKind",
    example: "LEAVE",
    description: "Request hits only: what kind of request",
  })
  requestKind?: string;

  @ApiPropertyOptional({
    enum: ["EMPLOYMENT", "INCOME"],
    enumName: "CertificateKind",
    example: "EMPLOYMENT",
    description: "Certificate hits only: which letter was asked for",
  })
  certificateKind?: string;

  @ApiPropertyOptional({
    enum: ["PERSONAL_EMAIL", "PHONE", "BANK", "NATIONAL_ID", "TAX_CODE", "SOCIAL_INSURANCE_NO"],
    enumName: "ProfileField",
    example: "PHONE",
    description: "Profile change hits only: which detail the change is for",
  })
  profileField?: string;

  @ApiPropertyOptional({
    enum: ["POLICY", "HANDBOOK", "NOTICE"],
    enumName: "DocumentKind",
    example: "POLICY",
    description: "Document hits only: what kind of document",
  })
  documentKind?: string;
}

export class SearchMoreView {
  @ApiProperty(KIND_DOC)
  kind!: string;

  @ApiProperty({
    example: "/employees?q=nguyen&active=",
    description: "The list page of that kind, carrying the term where the page reads one",
  })
  href!: string;
}

export class SearchReplyView {
  @ApiProperty({
    type: [SearchHitView],
    description: "At most five per kind, a match at the start of a word first, then the newest",
  })
  hits!: SearchHitView[];

  @ApiProperty({
    type: [SearchMoreView],
    description: "A line for each kind that has more than five and a list page the viewer opens with the term",
  })
  more!: SearchMoreView[];
}
