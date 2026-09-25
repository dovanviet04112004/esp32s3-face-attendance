import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import { IsBoolean, IsEnum, IsOptional, IsString, Matches, MaxLength, MinLength } from "class-validator";

import { PaginationDto } from "../../../common/dto/pagination.dto.js";

const DEVICE_STATUS = ["PENDING", "APPROVED", "REVOKED"] as const;
const CLAIM_CODE = /^\d{6}$/;

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

/** A name for the serial, and the code off its screen that proves presence (KEHOACH 7.3). */
export class ApproveDeviceDto extends UpdateDeviceDto {
  @ApiProperty({ example: "482913", description: "The claim code on the kiosk's screen" })
  @Matches(CLAIM_CODE)
  claimCode!: string;
}

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

  @ApiProperty({ example: "482913", description: "The code this kiosk shows while it waits" })
  @Matches(CLAIM_CODE)
  claimCode!: string;
}

export class ListDevicesDto extends PaginationDto {
  @ApiPropertyOptional({ enum: DEVICE_STATUS })
  @IsOptional()
  @IsEnum(DEVICE_STATUS)
  status?: (typeof DEVICE_STATUS)[number];

  @ApiPropertyOptional({ description: "Id, name, place or serial, any case", maxLength: 64 })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  search?: string;

  @ApiPropertyOptional({ description: "Approved kiosks that are online (true) or offline (false)" })
  @IsOptional()
  @Transform(({ value }) => value === true || value === "true")
  @IsBoolean()
  online?: boolean;
}

export class DeviceView {
  @ApiProperty() id!: string;
  @ApiProperty({ type: String, nullable: true }) serial!: string | null;
  @ApiProperty({ type: String, nullable: true }) name!: string | null;
  @ApiProperty({ type: String, nullable: true }) location!: string | null;
  @ApiProperty({ enum: DEVICE_STATUS }) status!: string;
  @ApiProperty({ type: String, nullable: true }) fwVersion!: string | null;
  @ApiProperty({ type: String, nullable: true }) modelVersion!: string | null;
  @ApiProperty({ type: String, nullable: true, example: "recog-f77969e342ab10b4", description: "Recognition model its templates belong to" })
  embeddingVersion!: string | null;
  @ApiProperty() rosterVersion!: number;
  @ApiProperty({ type: String, nullable: true, format: "date-time" }) lastSeenAt!: string | null;
  @ApiProperty() online!: boolean;
  @ApiProperty({ type: String, nullable: true }) approvedAt!: string | null;
}

export class DevicePageView {
  @ApiProperty({ type: [DeviceView] }) rows!: DeviceView[];
  @ApiProperty() total!: number;
  @ApiProperty() totalIsExact!: boolean;
}

export class DeviceCountsView {
  @ApiProperty() PENDING!: number;
  @ApiProperty() APPROVED!: number;
  @ApiProperty() REVOKED!: number;
  @ApiProperty({ description: "Approved and online" }) online!: number;
  @ApiProperty({ description: "Approved and offline" }) offline!: number;
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
