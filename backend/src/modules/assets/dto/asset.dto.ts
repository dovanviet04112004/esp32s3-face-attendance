import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { AssetCondition, AssetState } from "@prisma/client";
import { Type } from "class-transformer";
import { IsBoolean, IsEnum, IsInt, IsOptional, IsString, MaxLength, Min } from "class-validator";

import { PaginationDto } from "../../../common/dto/pagination.dto.js";

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

export class ListAssetsDto extends PaginationDto {
  @ApiPropertyOptional({ description: "Matches code, name, serial number or the holder's name" })
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
