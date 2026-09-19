import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsEnum, IsOptional, IsString, MaxLength } from "class-validator";

import { PaginationDto } from "../../../common/dto/pagination.dto.js";

const DEVICE_STATUS = ["PENDING", "APPROVED", "REVOKED"] as const;

export class UpdateDeviceDto {
  @ApiPropertyOptional({ maxLength: 64 })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  name?: string;

  @ApiPropertyOptional({ maxLength: 64 })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  location?: string;
}

/** Approving is where a person puts a readable name on a serial (KEHOACH 7.3). */
export class ApproveDeviceDto extends UpdateDeviceDto {}

export class ListDevicesDto extends PaginationDto {
  @ApiPropertyOptional({ enum: DEVICE_STATUS })
  @IsOptional()
  @IsEnum(DEVICE_STATUS)
  status?: (typeof DEVICE_STATUS)[number];
}
