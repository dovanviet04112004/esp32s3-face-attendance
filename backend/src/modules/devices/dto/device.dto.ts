import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import { IsBoolean, IsEnum, IsOptional, IsString, Matches, MaxLength, MinLength } from "class-validator";

import { OffsetPageDto } from "../../../common/dto/pagination.dto.js";

const DEVICE_STATUS = ["PENDING", "APPROVED", "REVOKED"] as const;
const CLAIM_CODE = /^\d{6}$/;

export class UpdateDeviceDto {
  @ApiPropertyOptional({ maxLength: 64, example: "Cổng chính", description: "Name the dashboard shows" })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  name?: string;

  @ApiPropertyOptional({ maxLength: 64, example: "Tầng 1, sảnh A", description: "Where the kiosk stands" })
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
  @ApiProperty({
    maxLength: DEVICE_ID_MAX,
    example: "kiosk-2884859fd3c8",
    description: "Id derived from the chip's eFuse MAC; 4 to 32 letters, digits, dash or underscore",
  })
  @IsString()
  @MaxLength(DEVICE_ID_MAX)
  deviceId!: string;

  @ApiProperty({
    minLength: BOOTSTRAP_MIN,
    maxLength: BOOTSTRAP_MAX,
    example: "batch-2026q3-7f3a9c1e5b2d4086",
    description: "Secret the firmware batch carries; it must equal DEVICE_BOOTSTRAP_TOKEN",
  })
  @IsString()
  @MinLength(BOOTSTRAP_MIN)
  @MaxLength(BOOTSTRAP_MAX)
  bootstrapToken!: string;

  @ApiPropertyOptional({
    maxLength: VERSION_MAX,
    example: "0.9.2",
    description: "Firmware the kiosk runs, MAJOR.MINOR.PATCH",
  })
  @IsOptional()
  @IsString()
  @MaxLength(VERSION_MAX)
  fwVersion?: string;

  @ApiProperty({ example: "482913", description: "The code this kiosk shows while it waits" })
  @Matches(CLAIM_CODE)
  claimCode!: string;
}

export class ListDevicesDto extends OffsetPageDto {
  @ApiPropertyOptional({ enum: DEVICE_STATUS, enumName: "DeviceStatus", description: "Only kiosks in this status" })
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
  @ApiProperty({ example: "kiosk-2884859fd3c8", description: "Kiosk id, from its eFuse MAC" }) id!: string;
  @ApiProperty({
    type: String,
    nullable: true,
    example: "SN-2026-00042",
    description: "Hardware serial; null if not recorded",
  })
  serial!: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    example: "Cổng chính",
    description: "Name the dashboard shows; null until named",
  })
  name!: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    example: "Tầng 1, sảnh A",
    description: "Where the kiosk stands; null until set",
  })
  location!: string | null;
  @ApiProperty({
    enum: DEVICE_STATUS,
    enumName: "DeviceStatus",
    example: "APPROVED",
    description: "PENDING waits for a person, APPROVED is in the fleet, REVOKED was taken back",
  })
  status!: string;
  @ApiProperty({
    type: String,
    nullable: true,
    example: "0.9.2",
    description: "Firmware it last reported; null before any",
  })
  fwVersion!: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    example: "img-3f9a12bc",
    description: "Models image it last reported; null before any heartbeat",
  })
  modelVersion!: string | null;
  @ApiProperty({ type: String, nullable: true, example: "recog-f77969e342ab10b4", description: "Recognition model its templates belong to" })
  embeddingVersion!: string | null;
  @ApiProperty({ example: 57, description: "Roster generation the server holds for it; heartbeats are compared to it" })
  rosterVersion!: number;
  @ApiProperty({
    type: String,
    nullable: true,
    format: "date-time",
    example: "2026-09-25T03:41:10.000Z",
    description: "When it was last heard from; null before any heartbeat",
  })
  lastSeenAt!: string | null;
  @ApiProperty({ example: true, description: "Up by its live heartbeats and the broker's last will" }) online!: boolean;
  @ApiProperty({
    type: Number,
    nullable: true,
    example: -1500,
    description: "Kiosk clock less server clock at its last live heartbeat, in ms; null until a beat carries a set clock",
  })
  clockSkewMs!: number | null;
  @ApiProperty({
    type: String,
    format: "date-time",
    nullable: true,
    example: "2026-08-02T04:00:00.000Z",
    description: "When a person approved it; null while pending or revoked",
  })
  approvedAt!: string | null;
  @ApiProperty({
    type: String,
    format: "date-time",
    nullable: true,
    example: "2026-09-01T02:00:00.000Z",
    description: "When it was last revoked, null if never; punches from then until readmittedAt are refused",
  })
  revokedAt!: string | null;
  @ApiProperty({
    type: String,
    format: "date-time",
    nullable: true,
    example: "2026-09-03T02:00:00.000Z",
    description: "When an approval after that revocation let it back in; null while still out",
  })
  readmittedAt!: string | null;
  @ApiProperty({
    type: String,
    format: "date-time",
    example: "2026-08-01T09:12:00.000Z",
    description: "When it first registered",
  })
  createdAt!: string;
  @ApiProperty({
    type: String,
    format: "date-time",
    example: "2026-09-25T03:41:10.000Z",
    description: "When the row last changed",
  })
  updatedAt!: string;
}

export class DevicePageView {
  @ApiProperty({ type: [DeviceView], description: "Pending kiosks first, then by id" }) rows!: DeviceView[];
  @ApiProperty({ example: 12, description: "Kiosks the filter reaches, counted no further than the ceiling" })
  total!: number;
  @ApiProperty({ example: true, description: "False when counting stopped at the ceiling, so total is a floor" })
  totalIsExact!: boolean;
}

export class DeviceCountsView {
  @ApiProperty({ example: 1, description: "Kiosks waiting for a person to approve them" }) PENDING!: number;
  @ApiProperty({ example: 10, description: "Kiosks in the fleet" }) APPROVED!: number;
  @ApiProperty({ example: 1, description: "Kiosks taken back" }) REVOKED!: number;
  @ApiProperty({ example: 9, description: "Approved and online" }) online!: number;
  @ApiProperty({ example: 1, description: "Approved and offline" }) offline!: number;
}

/** The 202 a kiosk gets while nobody has approved it yet (KEHOACH 7.3). */
export class DeviceWaitingView {
  @ApiProperty({ enum: [true], example: true, description: "Always true here: ask again after pollIntervalS" })
  accepted!: true;
  @ApiProperty({ example: "kiosk-2884859fd3c8", description: "The id the kiosk registered with" }) deviceId!: string;
  @ApiProperty({ example: 5, description: "Seconds to wait before asking again (DEVICE_POLL_INTERVAL_S)" })
  pollIntervalS!: number;
  @ApiPropertyOptional({
    enum: [true],
    example: true,
    description: "Sent only when the claim code was mistyped too often: show a new code and register again",
  })
  claimRenew?: true;
}

/** The 200 that carries a kiosk's token, on approval or on renewal (KEHOACH 7.3). */
export class DeviceTokenView {
  @ApiProperty({
    enum: [false],
    example: false,
    description: "Always false here: the kiosk is let in",
  })
  accepted!: false;
  @ApiProperty({ example: "kiosk-2884859fd3c8", description: "The kiosk the token is for" }) deviceId!: string;
  @ApiProperty({
    example: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJkZXZpY2VJZCI6Imtpb3NrLTI4ODQ4NTlmZDNjOCJ9.c2lnbmF0dXJl",
    description: "Device JWT for the API and the broker; the server keeps only its hash",
  })
  token!: string;
  @ApiProperty({
    example: 90,
    description: "Days until the token expires (DEVICE_TOKEN_TTL_DAYS)",
  })
  expiresInDays!: number;
}

export class DeviceIdentityView {
  @ApiProperty({ example: "kiosk-2884859fd3c8", description: "The kiosk the presented token belongs to" })
  deviceId!: string;
}

export class BrokerVerdictView {
  @ApiProperty({
    enum: ["allow", "deny"],
    enumName: "BrokerVerdict",
    example: "allow",
    description: "What EMQX does with the login",
  })
  result!: "allow" | "deny";
}

/** The login EMQX's http authenticator forwards (KEHOACH 7.4). */
export class BrokerLoginDto {
  @ApiProperty({
    maxLength: BROKER_NAME_MAX,
    example: "kiosk-2884859fd3c8",
    description: "The kiosk id; it must equal clientid",
  })
  @IsString()
  @MaxLength(BROKER_NAME_MAX)
  username!: string;

  @ApiProperty({
    maxLength: BROKER_SECRET_MAX,
    example: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJkZXZpY2VJZCI6Imtpb3NrLTI4ODQ4NTlmZDNjOCJ9.c2lnbmF0dXJl",
    description: "The device JWT",
  })
  @IsString()
  @MaxLength(BROKER_SECRET_MAX)
  password!: string;

  @ApiProperty({
    maxLength: BROKER_NAME_MAX,
    example: "kiosk-2884859fd3c8",
    description: "MQTT client id; a ticket owns exactly one, its kiosk id",
  })
  @IsString()
  @MaxLength(BROKER_NAME_MAX)
  clientid!: string;
}
