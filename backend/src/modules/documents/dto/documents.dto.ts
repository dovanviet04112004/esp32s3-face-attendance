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
  @ApiProperty({ description: "Short handle, unique across documents", example: "NOI-QUY-LAO-DONG", maxLength: 64 })
  @IsString()
  @MaxLength(64)
  code!: string;

  @ApiProperty({ description: "Heading readers see", example: "Noi quy lao dong", maxLength: 200 })
  @IsString()
  @MaxLength(200)
  title!: string;

  @ApiPropertyOptional({
    enum: DocumentKind,
    enumName: "DocumentKind",
    default: DocumentKind.POLICY,
    description: "What sort of text it is",
    example: DocumentKind.POLICY,
  })
  @IsOptional()
  @IsEnum(DocumentKind)
  kind?: DocumentKind;

  @ApiPropertyOptional({ description: "Blank means every department", example: "6c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f" })
  @IsOptional()
  @IsUUID()
  departmentId?: string;

  @ApiPropertyOptional({ description: "Blank means every job title", example: "2a3b4c5d-6e7f-4a8b-9c0d-1e2f3a4b5c6d" })
  @IsOptional()
  @IsUUID()
  jobTitleId?: string;
}

export class PublishVersionDto {
  @ApiProperty({ description: "The full wording; a published version is never edited", example: "Dieu 1. Gio lam viec..." })
  @IsString()
  @MinLength(1)
  body!: string;

  @ApiPropertyOptional({
    description: "What differs from the last version, for readers",
    example: "Sua gio lam viec ca chieu",
    maxLength: 240,
  })
  @IsOptional()
  @IsString()
  @MaxLength(240)
  summary?: string;
}

export class CreateFileTypeDto {
  @ApiProperty({ description: "Short handle, unique across kinds of paper", example: "CCCD", maxLength: 64 })
  @IsString()
  @MaxLength(64)
  code!: string;

  @ApiProperty({ description: "Name the desk sees", example: "Can cuoc cong dan", maxLength: 200 })
  @IsString()
  @MaxLength(200)
  name!: string;

  @ApiPropertyOptional({ default: true, description: "Whether every active person must hand one in", example: true })
  @IsOptional()
  @IsBoolean()
  required?: boolean;

  @ApiPropertyOptional({ example: 12, description: "Months the paper stays valid; left out for paper that never expires" })
  @IsOptional()
  @IsInt()
  @Min(1)
  validMonths?: number;

  @ApiPropertyOptional({ default: 0, description: "Position in lists, lowest first", example: 1 })
  @IsOptional()
  @IsInt()
  @Min(0)
  ordinal?: number;
}

export class ReceiveFileDto {
  @ApiProperty({ description: "Employee who handed the paper in", example: 1 })
  @IsInt()
  @Min(1)
  employeeId!: number;

  @ApiProperty({ description: "Kind of paper received", example: "9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d" })
  @IsUUID()
  typeId!: string;

  @ApiProperty({ description: "Day it arrived; its expiry counts from this day", example: "2026-09-21" })
  @IsDateString()
  receivedAt!: string;

  @ApiPropertyOptional({ description: "Free note kept on the receipt", example: "Ban sao cong chung", maxLength: 240 })
  @IsOptional()
  @IsString()
  @MaxLength(240)
  note?: string;
}

export class UpdateDocumentDto {
  @ApiPropertyOptional({ description: "Heading readers see", example: "Noi quy lao dong", maxLength: 200 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title?: string;

  @ApiPropertyOptional({
    enum: DocumentKind,
    enumName: "DocumentKind",
    description: "What sort of text it is",
    example: DocumentKind.HANDBOOK,
  })
  @IsOptional()
  @IsEnum(DocumentKind)
  kind?: DocumentKind;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: "Null means every department",
    example: "6c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f",
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsUUID()
  departmentId?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: "Null means every job title",
    example: "2a3b4c5d-6e7f-4a8b-9c0d-1e2f3a4b5c6d",
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsUUID()
  jobTitleId?: string | null;

  @ApiPropertyOptional({ description: "False retires it: nobody is asked to read it any more", example: false })
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class UpdateFileTypeDto {
  @ApiPropertyOptional({ description: "Name the desk sees", example: "Can cuoc cong dan", maxLength: 200 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name?: string;

  @ApiPropertyOptional({ description: "Whether every active person must hand one in", example: true })
  @IsOptional()
  @IsBoolean()
  required?: boolean;

  @ApiPropertyOptional({
    type: Number,
    example: 12,
    nullable: true,
    description: "Months the paper stays valid; null for paper that never expires",
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @Min(1)
  validMonths?: number | null;

  @ApiPropertyOptional({ description: "Position in lists, lowest first", example: 2 })
  @IsOptional()
  @IsInt()
  @Min(0)
  ordinal?: number;

  @ApiPropertyOptional({ description: "False retires it; papers already filed stay on record", example: false })
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
  @ApiProperty({ description: "Document id", example: "4d5e6f70-8192-4a3b-b4c5-d6e7f8091a2b" }) id!: string;
  @ApiProperty({ description: "Short handle, unique across documents", example: "NOI-QUY-LAO-DONG" }) code!: string;
  @ApiProperty({ description: "Heading readers see", example: "Noi quy lao dong" }) title!: string;
  @ApiProperty({ enum: DocumentKind, enumName: "DocumentKind", description: "What sort of text it is" }) kind!: DocumentKind;
  @ApiProperty({
    nullable: true,
    type: String,
    description: "Only people in this very department read it; null for every department",
    example: "6c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f",
  })
  departmentId!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    description: "Only people holding this job title read it; null for every title",
    example: "2a3b4c5d-6e7f-4a8b-9c0d-1e2f3a4b5c6d",
  })
  jobTitleId!: string | null;
  @ApiProperty({ description: "False once retired: nobody is asked to read it" }) active!: boolean;
  @ApiProperty({ type: String, format: "date-time", description: "When it was registered", example: "2026-01-05T02:00:00.000Z" })
  createdAt!: string;
  @ApiProperty({
    type: String,
    format: "date-time",
    description: "Last change to its title, kind, audience or standing",
    example: "2026-09-01T02:00:00.000Z",
  })
  updatedAt!: string;
}

export class VersionView {
  @ApiProperty({ description: "Version id; a signature points at it", example: "7a8b9c0d-1e2f-4031-a425-36475869708a" }) id!: string;
  @ApiProperty({ description: "Document this wording belongs to", example: "4d5e6f70-8192-4a3b-b4c5-d6e7f8091a2b" })
  documentId!: string;
  @ApiProperty({ description: "Number counting up from 1 within the document", example: 3 }) version!: number;
  @ApiProperty({ description: "The full wording, never edited once published", example: "Dieu 1. Gio lam viec..." }) body!: string;
  @ApiProperty({ nullable: true, type: String, description: "What differs from the last version", example: "Sua gio lam viec ca chieu" })
  summary!: string | null;
  @ApiProperty({ type: String, format: "date-time", description: "When it went out", example: "2026-09-01T02:00:00.000Z" })
  publishedAt!: string;
  @ApiProperty({
    nullable: true,
    type: String,
    description: "Account that published it",
    example: "b5f0c3d2-8a41-4e6b-9c2d-7f1e3a5b9c04",
  })
  publishedById!: string | null;
}

export class DocumentWithLatestView extends DocumentView {
  @ApiProperty({ type: [VersionView], description: "The newest version only, or none yet" })
  versions!: VersionView[];
}

export class ToReadView {
  @ApiProperty({ description: "Document id", example: "4d5e6f70-8192-4a3b-b4c5-d6e7f8091a2b" }) documentId!: string;
  @ApiProperty({ description: "Short handle of the document", example: "NOI-QUY-LAO-DONG" }) code!: string;
  @ApiProperty({ description: "Heading readers see", example: "Noi quy lao dong" }) title!: string;
  @ApiProperty({ description: "Id of the newest version, the one to sign for", example: "7a8b9c0d-1e2f-4031-a425-36475869708a" })
  versionId!: string;
  @ApiProperty({ description: "Its number within the document", example: 3 }) version!: number;
  @ApiProperty({ description: "Its full wording", example: "Dieu 1. Gio lam viec..." }) body!: string;
  @ApiProperty({ nullable: true, type: String, description: "What differs from the last version", example: "Sua gio lam viec ca chieu" })
  summary!: string | null;
  @ApiProperty({ type: String, format: "date-time", description: "When it went out", example: "2026-09-01T02:00:00.000Z" })
  publishedAt!: string;
  @ApiProperty({
    nullable: true,
    type: String,
    format: "date-time",
    description: "When the caller signed for this version; null while unsigned",
    example: "2026-09-02T01:15:00.000Z",
  })
  ackAt!: string | null;
}

export class UnreadCountView {
  @ApiProperty({ description: "Versions aimed at the caller that they have not signed for", example: 2 }) total!: number;
}

export class AckView {
  @ApiProperty({
    type: String,
    format: "date-time",
    description: "When the caller signed for it; signing again keeps the first time",
    example: "2026-09-02T01:15:00.000Z",
  })
  ackAt!: string;
}

export class FileTypeView {
  @ApiProperty({ description: "Kind of paper id", example: "9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d" }) id!: string;
  @ApiProperty({ description: "Short handle, unique across kinds of paper", example: "CCCD" }) code!: string;
  @ApiProperty({ description: "Name the desk sees", example: "Can cuoc cong dan" }) name!: string;
  @ApiProperty({ description: "Whether every active person must hand one in" }) required!: boolean;
  @ApiProperty({
    nullable: true,
    type: Number,
    description: "Months one stays valid once received; null when it never expires",
    example: 12,
  })
  validMonths!: number | null;
  @ApiProperty({ description: "Position in lists, lowest first", example: 1 }) ordinal!: number;
  @ApiProperty({ description: "False once retired: it no longer counts as missing" }) active!: boolean;
  @ApiProperty({ type: String, format: "date-time", description: "When it was added", example: "2026-01-05T02:00:00.000Z" })
  createdAt!: string;
  @ApiProperty({ type: String, format: "date-time", description: "Last change to the row", example: "2026-06-10T08:30:00.000Z" })
  updatedAt!: string;
}

export class ReaderRowView {
  @ApiProperty({ description: "Employee id", example: 42 }) employeeId!: number;
  @ApiProperty({ description: "Employee code", example: "NV0002" }) code!: string;
  @ApiProperty({ description: "Name as on the employee record", example: "Trần Thị B" }) fullName!: string;
  @ApiProperty({
    nullable: true,
    type: String,
    format: "date-time",
    description: "When they signed for this version; null while unsigned",
    example: "2026-09-02T01:15:00.000Z",
  })
  ackAt!: string | null;
}

export class ReaderPageView {
  @ApiProperty({ type: [ReaderRowView], description: "One page of readers: unsigned first, then by code" }) rows!: ReaderRowView[];
  @ApiProperty({ description: "Rows matching the filters" }) total!: number;
  @ApiProperty({ description: "False when counting stopped at the ceiling" }) totalIsExact!: boolean;
  @ApiProperty({
    nullable: true,
    type: String,
    description: "Pass back as cursor for the next page; null on the last page",
    example: "eyJzb3J0VmFsdWUiOiIwTlYwMDUwIiwiaWQiOiI1MCJ9",
  })
  next!: string | null;
  @ApiProperty({ description: "Everybody the version reaches who has not signed" }) unread!: number;
  @ApiProperty({ description: "False when the unread count stopped at the ceiling" }) unreadIsExact!: boolean;
}

export class GapPaperView {
  @ApiProperty({ description: "Kind of paper id", example: "9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d" }) typeId!: string;
  @ApiProperty({ description: "Short handle of the kind", example: "CCCD" }) code!: string;
  @ApiProperty({ description: "Name the desk sees", example: "Can cuoc cong dan" }) name!: string;
}

export class ExpiredPaperView extends GapPaperView {
  @ApiProperty({ format: "date", description: "Day the filed paper ran out", example: "2026-01-31" }) expiresAt!: string;
}

export class GapView {
  @ApiProperty({ description: "Employee id", example: 42 }) employeeId!: number;
  @ApiProperty({ description: "Employee code", example: "NV0002" }) code!: string;
  @ApiProperty({ description: "Name as on the employee record", example: "Trần Thị B" }) fullName!: string;
  @ApiProperty({ type: [GapPaperView], description: "Required kinds never handed in" }) missing!: GapPaperView[];
  @ApiProperty({ type: [ExpiredPaperView], description: "Required kinds handed in whose validity has run out" })
  expired!: ExpiredPaperView[];
}

export class GapPageView {
  @ApiProperty({ type: [GapView], description: "One page of people short of a paper, by code" }) rows!: GapView[];
  @ApiProperty({ description: "People short of a required paper, counted up to the ceiling" }) total!: number;
  @ApiPropertyOptional({ description: "False when counting stopped at the ceiling; absent when the caller sees nobody" })
  totalIsExact?: boolean;
  @ApiProperty({
    nullable: true,
    type: String,
    description: "Pass back as cursor for the next page; null on the last page",
    example: "eyJzb3J0VmFsdWUiOiJOVjAwNTAiLCJpZCI6IjUwIn0",
  })
  next!: string | null;
}

export class ReceivedView {
  @ApiProperty({
    description: "Receipt id; one per person and kind, so a second receipt rewrites the first",
    example: "3e4f5a6b-7c8d-49e0-af1b-2c3d4e5f6a7b",
  })
  id!: string;
  @ApiProperty({
    nullable: true,
    type: String,
    format: "date-time",
    description: "When the paper runs out, by its kind's validity, as midnight UTC; null when it never expires",
    example: "2027-09-21T00:00:00.000Z",
  })
  expiresAt!: string | null;
}
