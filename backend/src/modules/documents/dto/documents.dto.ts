import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { DocumentKind } from "@prisma/client";
import { Type } from "class-transformer";
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

/** One row per person a document reaches, so it pages (KEHOACH 9.9 rule 3). */
export class ListReadersDto extends PaginationDto {}

export class ListGapsDto extends PaginationDto {
  @ApiPropertyOptional({ description: "Narrow to one person's own record" })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  employeeId?: number;
}
