import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { DocumentKind } from "@prisma/client";
import { Transform, Type } from "class-transformer";
import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from "class-validator";

import { PaginationDto } from "../../../common/dto/pagination.dto.js";

export class CreateDocumentDto {
  @ApiProperty({ example: "NOI-QUY-LAO-DONG" })
  @IsString()
  @MaxLength(64)
  code!: string;

  @ApiProperty({ example: "Noi quy lao dong" })
  @IsString()
  @MaxLength(200)
  title!: string;

  @ApiPropertyOptional({ enum: DocumentKind, default: DocumentKind.POLICY })
  @IsOptional()
  @IsEnum(DocumentKind)
  kind?: DocumentKind;

  @ApiPropertyOptional({ description: "Blank means every department" })
  @IsOptional()
  @IsUUID()
  departmentId?: string;

  @ApiPropertyOptional({ description: "Blank means every job title" })
  @IsOptional()
  @IsUUID()
  jobTitleId?: string;
}

export class PublishVersionDto {
  @ApiProperty({ example: "Dieu 1. Gio lam viec..." })
  @IsString()
  @MinLength(1)
  body!: string;

  @ApiPropertyOptional({ example: "Sua gio lam viec ca chieu" })
  @IsOptional()
  @IsString()
  @MaxLength(240)
  summary?: string;
}

export class CreateFileTypeDto {
  @ApiProperty({ example: "CCCD" })
  @IsString()
  @MaxLength(64)
  code!: string;

  @ApiProperty({ example: "Can cuoc cong dan" })
  @IsString()
  @MaxLength(200)
  name!: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  required?: boolean;

  @ApiPropertyOptional({ example: 12, description: "Months the paper stays valid" })
  @IsOptional()
  @IsInt()
  @Min(1)
  validMonths?: number;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  ordinal?: number;
}

export class ReceiveFileDto {
  @ApiProperty({ example: 1 })
  @IsInt()
  @Min(1)
  employeeId!: number;

  @ApiProperty()
  @IsUUID()
  typeId!: string;

  @ApiProperty({ example: "2026-09-21" })
  @IsDateString()
  receivedAt!: string;

  @ApiPropertyOptional({ example: "Ban sao cong chung" })
  @IsOptional()
  @IsString()
  @MaxLength(240)
  note?: string;
}

export class UpdateDocumentDto {
  @ApiPropertyOptional({ example: "Noi quy lao dong", maxLength: 200 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title?: string;

  @ApiPropertyOptional({ enum: DocumentKind })
  @IsOptional()
  @IsEnum(DocumentKind)
  kind?: DocumentKind;

  @ApiPropertyOptional({ nullable: true, description: "Null means every department" })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsUUID()
  departmentId?: string | null;

  @ApiPropertyOptional({ nullable: true, description: "Null means every job title" })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsUUID()
  jobTitleId?: string | null;

  @ApiPropertyOptional({ description: "False retires it: nobody is asked to read it any more" })
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class UpdateFileTypeDto {
  @ApiPropertyOptional({ example: "Can cuoc cong dan", maxLength: 200 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  required?: boolean;

  @ApiPropertyOptional({ example: 12, nullable: true, description: "Null for paper that never expires" })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @Min(1)
  validMonths?: number | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  ordinal?: number;

  @ApiPropertyOptional({ description: "False retires it; papers already filed stay on record" })
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class ListAllDto {
  @ApiPropertyOptional({ default: false, description: "Include retired rows" })
  @IsOptional()
  @Transform(({ value }) => value === true || value === "true")
  @IsBoolean()
  all?: boolean;
}

/** One row per person a document reaches, so it pages (KEHOACH 9.9 rule 3). */
export class ListReadersDto extends PaginationDto {
  @ApiPropertyOptional({ minimum: 1, description: "A published version number; the newest when left out" })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  version?: number;

  @ApiPropertyOptional({ maxLength: 64, description: "Employee code or full name, any case" })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  search?: string;

  @ApiPropertyOptional({ default: false, description: "Only the people who have not signed yet" })
  @IsOptional()
  @Transform(({ value }) => value === true || value === "true")
  @IsBoolean()
  unsigned?: boolean;
}

export class ListGapsDto extends PaginationDto {
  @ApiPropertyOptional({ description: "Narrow to one person's own record" })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  employeeId?: number;

  @ApiPropertyOptional({ maxLength: 64, description: "Employee code or full name, any case" })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  search?: string;

  @ApiPropertyOptional({ description: "This department and every department under it" })
  @IsOptional()
  @IsUUID()
  departmentId?: string;
}

export class DocumentView {
  @ApiProperty() id!: string;
  @ApiProperty() code!: string;
  @ApiProperty() title!: string;
  @ApiProperty({ enum: DocumentKind }) kind!: DocumentKind;
  @ApiProperty({ nullable: true, type: String }) departmentId!: string | null;
  @ApiProperty({ nullable: true, type: String }) jobTitleId!: string | null;
  @ApiProperty() active!: boolean;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class VersionView {
  @ApiProperty() id!: string;
  @ApiProperty() documentId!: string;
  @ApiProperty() version!: number;
  @ApiProperty() body!: string;
  @ApiProperty({ nullable: true, type: String }) summary!: string | null;
  @ApiProperty() publishedAt!: string;
  @ApiProperty({ nullable: true, type: String }) publishedById!: string | null;
}

export class DocumentWithLatestView extends DocumentView {
  @ApiProperty({ type: [VersionView], description: "The newest version only, or none yet" })
  versions!: VersionView[];
}

export class FileTypeView {
  @ApiProperty() id!: string;
  @ApiProperty() code!: string;
  @ApiProperty() name!: string;
  @ApiProperty() required!: boolean;
  @ApiProperty({ nullable: true, type: Number }) validMonths!: number | null;
  @ApiProperty() ordinal!: number;
  @ApiProperty() active!: boolean;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class ReaderRowView {
  @ApiProperty() employeeId!: number;
  @ApiProperty() code!: string;
  @ApiProperty() fullName!: string;
  @ApiProperty({ nullable: true, type: String }) ackAt!: string | null;
}

export class ReaderPageView {
  @ApiProperty({ type: [ReaderRowView] }) rows!: ReaderRowView[];
  @ApiProperty({ description: "Rows matching the filters" }) total!: number;
  @ApiProperty() totalIsExact!: boolean;
  @ApiProperty({ nullable: true, type: String }) next!: string | null;
  @ApiProperty({ description: "Everybody the version reaches who has not signed" }) unread!: number;
  @ApiProperty() unreadIsExact!: boolean;
}

export class GapPaperView {
  @ApiProperty() typeId!: string;
  @ApiProperty() code!: string;
  @ApiProperty() name!: string;
}

export class ExpiredPaperView extends GapPaperView {
  @ApiProperty({ example: "2026-01-31" }) expiresAt!: string;
}

export class GapView {
  @ApiProperty() employeeId!: number;
  @ApiProperty() code!: string;
  @ApiProperty() fullName!: string;
  @ApiProperty({ type: [GapPaperView] }) missing!: GapPaperView[];
  @ApiProperty({ type: [ExpiredPaperView] }) expired!: ExpiredPaperView[];
}

export class GapPageView {
  @ApiProperty({ type: [GapView] }) rows!: GapView[];
  @ApiProperty() total!: number;
  @ApiProperty() totalIsExact!: boolean;
  @ApiProperty({ nullable: true, type: String }) next!: string | null;
}

export class ReceivedView {
  @ApiProperty() id!: string;
  @ApiProperty({ nullable: true, type: String }) expiresAt!: string | null;
}
