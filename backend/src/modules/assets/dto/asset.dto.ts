import { ApiProperty, ApiPropertyOptional, IntersectionType } from "@nestjs/swagger";
import { AssetCondition, AssetState } from "@prisma/client";
import { Type } from "class-transformer";
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from "class-validator";

import { PaginationDto } from "../../../common/dto/pagination.dto.js";
import { DepartmentRef } from "../../leave/dto/queue.dto.js";

export class CreateAssetDto {
  @ApiProperty({ example: "TS0142" })
  @IsString()
  @MaxLength(32)
  code!: string;

  @ApiProperty({ example: "Máy tính xách tay Dell 5430" })
  @IsString()
  @MaxLength(160)
  name!: string;

  @ApiProperty({ example: "LAPTOP" })
  @IsString()
  @MaxLength(32)
  kind!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  serialNo?: string;
}

export class HandOverDto {
  @ApiProperty({ description: "Who it goes to, or who is giving it back" })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  employeeId!: number;

  @ApiProperty({ description: "True hands it out, false takes it back" })
  @IsBoolean()
  issued!: boolean;

  @ApiPropertyOptional({ enum: AssetCondition })
  @IsOptional()
  @IsEnum(AssetCondition)
  condition?: AssetCondition;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class UpdateAssetDto {
  @ApiPropertyOptional({ example: "Máy tính xách tay Dell 5430", maxLength: 160 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  name?: string;

  @ApiPropertyOptional({ example: "LAPTOP", maxLength: 32 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(32)
  kind?: string;

  @ApiPropertyOptional({ maxLength: 64, nullable: true })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(64)
  serialNo?: string | null;

  @ApiPropertyOptional({ maxLength: 500, nullable: true })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(500)
  note?: string | null;
}

/** The filters the register, its counts and its export share. */
export class AssetFilterDto {
  @ApiPropertyOptional({ description: "Matches code, name, serial number or the holder's name or code" })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  search?: string;

  @ApiPropertyOptional({ enum: AssetState })
  @IsOptional()
  @IsEnum(AssetState)
  state?: AssetState;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(32)
  kind?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  holderId?: number;
}

export class ListAssetsDto extends IntersectionType(PaginationDto, AssetFilterDto) {}

export class AssetHolderView {
  @ApiProperty() id!: number;
  @ApiProperty() code!: string;
  @ApiProperty() fullName!: string;
  @ApiProperty({ type: DepartmentRef, nullable: true }) department!: DepartmentRef | null;
}

export class AssetView {
  @ApiProperty() id!: string;
  @ApiProperty() code!: string;
  @ApiProperty() name!: string;
  @ApiProperty() kind!: string;
  @ApiProperty({ nullable: true, type: String }) serialNo!: string | null;
  @ApiProperty({ enum: AssetState }) state!: AssetState;
  @ApiProperty({ nullable: true, type: Number }) holderId!: number | null;
  @ApiProperty({ nullable: true, type: String }) note!: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class AssetRowView extends AssetView {
  @ApiProperty({ type: AssetHolderView, nullable: true }) holder!: AssetHolderView | null;
  @ApiProperty({ nullable: true, type: String, description: "When the current holder took it" })
  issuedAt!: string | null;
}

export class AssetPageView {
  @ApiProperty({ type: [AssetRowView] }) rows!: AssetRowView[];
  @ApiProperty() total!: number;
  @ApiProperty() totalIsExact!: boolean;
  @ApiProperty({ nullable: true, type: String }) next!: string | null;
}

export class AssetStatesView {
  @ApiProperty() IN_STOCK!: number;
  @ApiProperty() ISSUED!: number;
  @ApiProperty() RETURNED!: number;
  @ApiProperty() RETIRED!: number;
  @ApiProperty() LOST!: number;
}

export class AssetCountsView {
  @ApiProperty({ type: AssetStatesView, description: "Under the same search, kind and holder" })
  states!: AssetStatesView;
  @ApiProperty({ type: [String] }) kinds!: string[];
}
