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
  @ApiProperty({ enum: KINDS })
  @IsEnum(KINDS)
  kind!: (typeof KINDS)[number];

  @ApiProperty({ maxLength: PURPOSE_MAX, example: "Vay ngân hàng" })
  @IsString()
  @MaxLength(PURPOSE_MAX)
  purpose!: string;

  @ApiPropertyOptional({ minimum: MONTHS_MIN, maximum: MONTHS_MAX })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(MONTHS_MIN)
  @Max(MONTHS_MAX)
  months?: number;
}

export class DecideCertificateDto {
  @ApiPropertyOptional({ maxLength: NOTE_MAX })
  @IsOptional()
  @IsString()
  @MaxLength(NOTE_MAX)
  note?: string;
}

export class ListCertificatesDto extends QueueQueryDto {
  @ApiPropertyOptional({ enum: STATES, description: "REQUESTED is the desk's queue, without its own rows" })
  @IsOptional()
  @IsEnum(STATES)
  state?: (typeof STATES)[number];

  @ApiPropertyOptional({ enum: KINDS })
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
  @ApiProperty()
  id!: string;

  @ApiProperty()
  employeeId!: number;

  @ApiProperty({ enum: KINDS })
  kind!: string;

  @ApiProperty({ enum: STATES })
  state!: string;

  @ApiProperty()
  purpose!: string;

  @ApiProperty({ nullable: true, description: "Income letters: how many months it covers" })
  months!: number | null;

  @ApiProperty({ nullable: true, example: "2026/00012" })
  serial!: string | null;

  @ApiProperty({ nullable: true })
  issuedAt!: Date | null;

  @ApiProperty({ nullable: true })
  note!: string | null;

  @ApiProperty()
  createdAt!: Date;
}

export class CertificateRowView extends CertificateView {
  @ApiProperty({ type: PersonView })
  employee!: PersonView;

  @ApiProperty({ description: "Whole days since it was asked for" })
  waitedDays!: number;
}

export class CertificatePageView extends PageMeta {
  @ApiProperty({ type: [CertificateRowView] })
  rows!: CertificateRowView[];
}

export class LetterView {
  @ApiProperty({ example: "2026/00012" })
  serial!: string;

  @ApiProperty({ description: "The letter, ready to print" })
  text!: string;
}
