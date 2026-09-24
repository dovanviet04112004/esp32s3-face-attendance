import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsIn, IsInt, IsOptional, IsString, Matches, MaxLength } from "class-validator";

import { PUBLISHED_TARGETS, type PublishedTarget } from "../models.service.js";

const SEMVER = /^\d+\.\d+\.\d+$/;

/** What the publisher states about the file in the body; the file itself is the rest. */
export class PublishQueryDto {
  @ApiProperty({ enum: PUBLISHED_TARGETS })
  @IsIn(PUBLISHED_TARGETS)
  target!: PublishedTarget;

  @ApiProperty({ example: "0.9.2", description: "MAJOR.MINOR.PATCH for FIRMWARE, img-<crc32> for MODELS" })
  @IsString()
  @MaxLength(32)
  version!: string;

  @ApiPropertyOptional({ example: "0.9.0", description: "MODELS only" })
  @IsOptional()
  @Matches(SEMVER)
  minFwVersion?: string;

  @ApiPropertyOptional({ description: "The ml/ run this image came from" })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  runId?: string;
}

/** The signed part of a download link, which is the whole of its authority. */
export class ImageLinkDto {
  @ApiProperty({ example: "kiosk-2884859fd3c8" })
  @IsString()
  @MaxLength(32)
  device!: string;

  @ApiProperty({ description: "Unix seconds after which the link is refused" })
  @Type(() => Number)
  @IsInt()
  exp!: number;

  @ApiProperty({ description: "HMAC-SHA256 of release, device and expiry" })
  @IsString()
  @MaxLength(64)
  sig!: string;
}
