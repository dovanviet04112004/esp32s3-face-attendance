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
  @ApiProperty({ description: "Asset tag, unique on the register", example: "TS0142", maxLength: 32 })
  @IsString()
  @MaxLength(32)
  code!: string;

  @ApiProperty({ description: "What the item is, as the register lists it", example: "Máy tính xách tay Dell 5430", maxLength: 160 })
  @IsString()
  @MaxLength(160)
  name!: string;

  @ApiProperty({ description: "Free-text category the register groups and filters by", example: "LAPTOP", maxLength: 32 })
  @IsString()
  @MaxLength(32)
  kind!: string;

  @ApiPropertyOptional({ description: "Manufacturer's serial number, when the item has one", example: "5CD1234XYZ", maxLength: 64 })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  serialNo?: string;
}

export class HandOverDto {
  @ApiProperty({ description: "Who it goes to, or who is giving it back", example: 42 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  employeeId!: number;

  @ApiProperty({ description: "True hands it out, false takes it back", example: true })
  @IsBoolean()
  issued!: boolean;

  @ApiPropertyOptional({
    enum: AssetCondition,
    enumName: "AssetCondition",
    description: "State of the item at the hand-over; GOOD when left out",
    example: AssetCondition.GOOD,
  })
  @IsOptional()
  @IsEnum(AssetCondition)
  condition?: AssetCondition;

  @ApiPropertyOptional({ maxLength: 500, description: "Free note kept on the hand-over row", example: "Thiếu sạc" })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class UpdateAssetDto {
  @ApiPropertyOptional({
    description: "What the item is, as the register lists it",
    example: "Máy tính xách tay Dell 5430",
    maxLength: 160,
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  name?: string;

  @ApiPropertyOptional({ description: "Free-text category the register groups and filters by", example: "LAPTOP", maxLength: 32 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(32)
  kind?: string;

  @ApiPropertyOptional({
    maxLength: 64,
    nullable: true,
    description: "Manufacturer's serial number; null clears it",
    example: "5CD1234XYZ",
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(64)
  serialNo?: string | null;

  @ApiPropertyOptional({
    maxLength: 500,
    nullable: true,
    description: "Free note on the item; null clears it",
    example: "Màn hình có vết xước",
  })
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

  @ApiPropertyOptional({ enum: AssetState, enumName: "AssetState", description: "Only assets in this state" })
  @IsOptional()
  @IsEnum(AssetState)
  state?: AssetState;

  @ApiPropertyOptional({ description: "Only assets of this kind, matched exactly", example: "LAPTOP" })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  kind?: string;

  @ApiPropertyOptional({ description: "Only the assets this employee holds now", example: 42 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  holderId?: number;
}

export class ListAssetsDto extends IntersectionType(PaginationDto, AssetFilterDto) {}

export class AssetHolderView {
  @ApiProperty({ description: "Employee id", example: 42 }) id!: number;
  @ApiProperty({ description: "Employee code", example: "NV0002" }) code!: string;
  @ApiProperty({ description: "Name as on the employee record", example: "Trần Thị B" }) fullName!: string;
  @ApiProperty({ type: DepartmentRef, nullable: true, description: "Department the person sits in, if any" })
  department!: DepartmentRef | null;
}

export class AssetView {
  @ApiProperty({ description: "Asset id", example: "8f7e6d5c-4b3a-4291-8e7d-6c5b4a392817" }) id!: string;
  @ApiProperty({ description: "Asset tag, unique on the register", example: "TS0142" }) code!: string;
  @ApiProperty({ description: "What the item is", example: "Máy tính xách tay Dell 5430" }) name!: string;
  @ApiProperty({ description: "Free-text category", example: "LAPTOP" }) kind!: string;
  @ApiProperty({ nullable: true, type: String, description: "Manufacturer's serial number, if recorded", example: "5CD1234XYZ" })
  serialNo!: string | null;
  @ApiProperty({
    enum: AssetState,
    enumName: "AssetState",
    description: "Not yet handed out, held by someone, given back, taken out of use, or lost",
  })
  state!: AssetState;
  @ApiProperty({ nullable: true, type: Number, description: "Employee holding it; set only while ISSUED", example: 42 })
  holderId!: number | null;
  @ApiProperty({ nullable: true, type: String, description: "Free note on the item" }) note!: string | null;
  @ApiProperty({
    type: String,
    format: "date-time",
    description: "When it was put on the register",
    example: "2026-03-02T01:20:00.000Z",
  })
  createdAt!: string;
  @ApiProperty({
    type: String,
    format: "date-time",
    description: "Last change to the row, a hand-over included",
    example: "2026-09-14T07:45:10.000Z",
  })
  updatedAt!: string;
}

export class AssetWithHolderView extends AssetView {
  @ApiProperty({ type: AssetHolderView, nullable: true, description: "The person holding it now; null unless ISSUED" })
  holder!: AssetHolderView | null;
}

export class AssetRowView extends AssetWithHolderView {
  @ApiProperty({
    nullable: true,
    type: String,
    format: "date-time",
    description: "When the current holder took it; null unless ISSUED",
    example: "2026-09-14T07:45:10.000Z",
  })
  issuedAt!: string | null;
}

export class AssetTransferView {
  @ApiProperty({ description: "Hand-over row id", example: "1c2d3e4f-5a6b-4c7d-9e8f-0a1b2c3d4e5f" }) id!: string;
  @ApiProperty({ description: "The asset handed over", example: "8f7e6d5c-4b3a-4291-8e7d-6c5b4a392817" }) assetId!: string;
  @ApiProperty({ description: "Employee who received it or gave it back", example: 42 }) employeeId!: number;
  @ApiProperty({ description: "True for a hand-out, false for a return" }) issued!: boolean;
  @ApiProperty({ type: String, format: "date-time", description: "When the hand-over was recorded", example: "2026-09-14T07:45:10.000Z" })
  at!: string;
  @ApiProperty({ enum: AssetCondition, enumName: "AssetCondition", description: "State of the item at the hand-over" })
  condition!: AssetCondition;
  @ApiProperty({ nullable: true, type: String, description: "Note written at the hand-over" }) note!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    description: "Account that recorded it; null once that account is deleted",
    example: "b5f0c3d2-8a41-4e6b-9c2d-7f1e3a5b9c04",
  })
  byUserId!: string | null;
  @ApiProperty({ type: AssetHolderView, description: "The person on the other end of the hand-over" })
  employee!: AssetHolderView;
}

export class AssetPageView {
  @ApiProperty({ type: [AssetRowView], description: "One page of the register, by code" }) rows!: AssetRowView[];
  @ApiProperty({ description: "Assets matching the filters, counted up to the ceiling" }) total!: number;
  @ApiProperty({ description: "False when counting stopped at the ceiling" }) totalIsExact!: boolean;
  @ApiProperty({
    nullable: true,
    type: String,
    description: "Pass back as cursor for the next page: the last row's code; null on the last page",
    example: "TS0142",
  })
  next!: string | null;
}

export class AssetStatesView {
  @ApiProperty({ description: "Registered and not yet handed out" }) IN_STOCK!: number;
  @ApiProperty({ description: "Held by someone now" }) ISSUED!: number;
  @ApiProperty({ description: "Given back and free to hand out again" }) RETURNED!: number;
  @ApiProperty({ description: "Taken out of use" }) RETIRED!: number;
  @ApiProperty({ description: "Reported lost" }) LOST!: number;
}

export class AssetCountsView {
  @ApiProperty({ type: AssetStatesView, description: "Assets per state, under the same search, kind and holder" })
  states!: AssetStatesView;
  @ApiProperty({
    type: [String],
    description: "Every kind on the register, A to Z, whatever the filters",
    example: ["LAPTOP", "MONITOR", "PHONE"],
  })
  kinds!: string[];
}
