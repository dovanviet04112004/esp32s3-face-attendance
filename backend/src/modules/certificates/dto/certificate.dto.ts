import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsEnum, IsInt, IsOptional, IsString, Max, MaxLength, Min } from "class-validator";

import { PageMeta, PersonView, QueueQueryDto } from "../../leave/dto/queue.dto.js";

const KINDS = ["EMPLOYMENT", "INCOME"] as const;
const STATES = ["REQUESTED", "ISSUED", "REJECTED"] as const;
const PURPOSE_MAX = 200;
const NOTE_MAX = 500;
const MONTHS_MIN = 1;
const MONTHS_MAX = 24;

export class AskCertificateDto {
  @ApiProperty({
    enum: KINDS,
    enumName: "CertificateKind",
    description: "EMPLOYMENT confirms the job; INCOME adds the net pay of recent months",
    example: "INCOME",
  })
  @IsEnum(KINDS)
  kind!: (typeof KINDS)[number];

  @ApiProperty({ maxLength: PURPOSE_MAX, description: "What the letter is for; it is printed on the letter", example: "Vay ngân hàng" })
  @IsString()
  @MaxLength(PURPOSE_MAX)
  purpose!: string;

  @ApiPropertyOptional({
    minimum: MONTHS_MIN,
    maximum: MONTHS_MAX,
    description: "Months of net pay an INCOME letter lists; 3 when left out, ignored for EMPLOYMENT",
    example: 6,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(MONTHS_MIN)
  @Max(MONTHS_MAX)
  months?: number;
}

export class DecideCertificateDto {
  @ApiPropertyOptional({
    maxLength: NOTE_MAX,
    description: "Why it was turned down; the asker reads it",
    example: "Chưa ghi rõ nơi nộp giấy",
  })
  @IsOptional()
  @IsString()
  @MaxLength(NOTE_MAX)
  note?: string;
}

export class ListCertificatesDto extends QueueQueryDto {
  @ApiPropertyOptional({
    enum: STATES,
    enumName: "CertificateState",
    description: "REQUESTED is the desk's queue, without its own rows",
  })
  @IsOptional()
  @IsEnum(STATES)
  state?: (typeof STATES)[number];

  @ApiPropertyOptional({ enum: KINDS, enumName: "CertificateKind", description: "Only letters of this kind" })
  @IsOptional()
  @IsEnum(KINDS)
  kind?: (typeof KINDS)[number];

  @ApiPropertyOptional({ description: "Whose letters; everything in scope when left out" })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  employeeId?: number;
}

export class CertificateView {
  @ApiProperty({ description: "Certificate id", example: "9d0e1f2a-3b4c-4d5e-8f6a-7b8c9d0e1f2a" })
  id!: string;

  @ApiProperty({ description: "Employee the letter is about", example: 42 })
  employeeId!: number;

  @ApiProperty({ enum: KINDS, enumName: "CertificateKind", description: "Letter of employment or of income" })
  kind!: string;

  @ApiProperty({ enum: STATES, enumName: "CertificateState", description: "Waiting for the desk, handed out, or turned down" })
  state!: string;

  @ApiProperty({ description: "What the asker needs it for, as printed on the letter", example: "Vay ngân hàng" })
  purpose!: string;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: "Months of net pay an income letter lists; null for an employment letter",
    example: 3,
  })
  months!: number | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: "Register number minted at issue, year and sequence; null until issued",
    example: "2026/00012",
  })
  serial!: string | null;

  @ApiProperty({
    type: String,
    format: "date-time",
    nullable: true,
    description: "When it was handed out; null until then",
    example: "2026-09-22T03:10:00.000Z",
  })
  issuedAt!: Date | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: "Account that issued or turned it down; null while it waits",
    example: "b5f0c3d2-8a41-4e6b-9c2d-7f1e3a5b9c04",
  })
  issuedById!: string | null;

  @ApiProperty({ type: String, nullable: true, description: "Why it was turned down; null otherwise" })
  note!: string | null;

  @ApiProperty({ type: String, format: "date-time", description: "When it was asked for", example: "2026-09-20T01:30:00.000Z" })
  createdAt!: Date;

  @ApiProperty({ type: String, format: "date-time", description: "Last change to the row", example: "2026-09-22T03:10:00.000Z" })
  updatedAt!: Date;
}

export class CertificateRowView extends CertificateView {
  @ApiProperty({ type: PersonView, description: "Who asked, with their department" })
  employee!: PersonView;

  @ApiProperty({ description: "Whole days since it was asked for", example: 2 })
  waitedDays!: number;
}

export class CertificatePageView extends PageMeta {
  @ApiProperty({
    type: [CertificateRowView],
    description: "One page of letters by asking time: oldest first for REQUESTED, newest first otherwise, unless order says",
  })
  rows!: CertificateRowView[];
}

export class LetterView {
  @ApiProperty({ description: "Register number printed on the letter", example: "2026/00012" })
  serial!: string;

  @ApiProperty({
    description: "The letter, ready to print: plain text in Vietnamese and English, lines split by \\n",
    example: "CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM\nSOCIALIST REPUBLIC OF VIETNAM\nĐộc lập - Tự do - Hạnh phúc",
  })
  text!: string;
}
