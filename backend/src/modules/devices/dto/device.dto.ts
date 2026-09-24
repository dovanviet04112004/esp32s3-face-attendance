import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsEnum, IsOptional, IsString, MaxLength, MinLength } from "class-validator";

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

const DEVICE_ID_MAX = 32;
const BOOTSTRAP_MIN = 16;
const BOOTSTRAP_MAX = 256;
const VERSION_MAX = 32;
const BROKER_NAME_MAX = 64;
const BROKER_SECRET_MAX = 2048;

/** What a kiosk with an empty NVS can say about itself: the id burned into its
 *  eFuse, and the secret its firmware batch carries (KEHOACH 7.3).
 */
export class RegisterDeviceDto {
  @ApiProperty({ maxLength: DEVICE_ID_MAX, example: "kiosk-2884859fd3c8" })
  @IsString()
  @MaxLength(DEVICE_ID_MAX)
  deviceId!: string;

  @ApiProperty({ minLength: BOOTSTRAP_MIN, maxLength: BOOTSTRAP_MAX })
  @IsString()
  @MinLength(BOOTSTRAP_MIN)
  @MaxLength(BOOTSTRAP_MAX)
  bootstrapToken!: string;

  @ApiPropertyOptional({ maxLength: VERSION_MAX })
  @IsOptional()
  @IsString()
  @MaxLength(VERSION_MAX)
  fwVersion?: string;
}

export class ListDevicesDto extends PaginationDto {
  @ApiPropertyOptional({ enum: DEVICE_STATUS })
  @IsOptional()
  @IsEnum(DEVICE_STATUS)
  status?: (typeof DEVICE_STATUS)[number];
}

/** The login EMQX's http authenticator forwards (KEHOACH 7.4). */
export class BrokerLoginDto {
  @ApiProperty({ maxLength: BROKER_NAME_MAX, example: "kiosk-2884859fd3c8" })
  @IsString()
  @MaxLength(BROKER_NAME_MAX)
  username!: string;

  @ApiProperty({ maxLength: BROKER_SECRET_MAX, description: "The device JWT" })
  @IsString()
  @MaxLength(BROKER_SECRET_MAX)
  password!: string;

  @ApiProperty({ maxLength: BROKER_NAME_MAX, example: "kiosk-2884859fd3c8" })
  @IsString()
  @MaxLength(BROKER_NAME_MAX)
  clientid!: string;
}
