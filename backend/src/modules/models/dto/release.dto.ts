import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Matches, MaxLength } from "class-validator";

import { PUBLISHED_TARGETS, type PublishedTarget } from "../models.service.js";

const SEMVER = /^\d+\.\d+\.\d+$/;

/** What the publisher states about the file in the body; the file itself is the rest. */
export class PublishQueryDto {
  @ApiProperty({
    enum: PUBLISHED_TARGETS,
    enumName: "PublishedTarget",
    example: "FIRMWARE",
    description: "Which kind of image: the firmware app, or the models partition",
  })
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

/** An offer to the whole fleet; `recapture` is the admin's word that everyone is captured again (KEHOACH 7.5). */
export class OfferAllDto {
  @ApiPropertyOptional({ example: false, description: "Required when the release changes recognition" })
  @IsOptional()
  @IsBoolean()
  recapture?: boolean;
}

/** The signed part of a download link, which is the whole of its authority. */
export class ImageLinkDto {
  @ApiProperty({ example: "kiosk-2884859fd3c8", description: "The kiosk the link was signed for; it must be approved" })
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

export class ReleaseViewDto {
  @ApiProperty({
    example: "ae489569-fcc0-4393-9669-2d459d7c57bd",
    description: "Release id (UUID)",
  })
  releaseId!: string;
  @ApiProperty({
    enum: ["FIRMWARE", "MODELS", "ASSETS"],
    enumName: "ReleaseTarget",
    example: "FIRMWARE",
    description: "Which partition the image installs to",
  })
  target!: string;
  @ApiProperty({ example: "0.9.2", description: "MAJOR.MINOR.PATCH for FIRMWARE, img-<crc32> for MODELS" })
  version!: string;
  @ApiProperty({
    example: "2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881",
    description: "SHA-256 of the file, 64 hex characters",
  })
  sha256!: string;
  @ApiProperty({ example: 1572864, description: "File size in bytes" }) sizeBytes!: number;
  @ApiProperty({
    type: String,
    nullable: true,
    example: "0.9.0",
    description: "Oldest firmware that may install it; null when any may",
  })
  minFwVersion!: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    example: "2026-09-18_4c1d2e7_a91f03",
    description: "The ml/ run the image came from; null if not stated",
  })
  runId!: string | null;
  @ApiProperty({ type: String, nullable: true, example: "recog-f77969e342ab10b4", description: "MODELS only" })
  embeddingVersion!: string | null;
  @ApiProperty({
    enum: ["DRAFT", "ROLLING", "PAUSED", "COMPLETED"],
    enumName: "RolloutState",
    example: "ROLLING",
    description: "DRAFT until first offered; ROLLING once any kiosk was offered it",
  })
  rolloutState!: string;
  @ApiProperty({
    example: true,
    description: "The file is still on the volume, so it can be offered",
  })
  available!: boolean;
  @ApiProperty({
    type: String,
    format: "date-time",
    example: "2026-09-18T07:00:00.000Z",
    description: "When it was published",
  })
  createdAt!: string;
  @ApiProperty({
    type: String,
    format: "date-time",
    example: "2026-09-20T03:15:00.000Z",
    description: "When the row last changed",
  })
  updatedAt!: string;
}

export class FleetUpdateView {
  @ApiProperty({ type: ReleaseViewDto, description: "Newest release of this kind still on the volume" })
  release!: ReleaseViewDto;
  @ApiProperty({
    type: [String],
    example: ["kiosk-2884859fd3c8"],
    description: "Approved kiosks running something older",
  })
  behind!: string[];
  @ApiProperty({
    type: [String],
    example: ["kiosk-5c1a77e09b42"],
    description: "Behind, but still installing an earlier offer",
  })
  updating!: string[];
  @ApiProperty({
    type: [String],
    example: ["kiosk-9e0b41d2c7aa"],
    description: "Behind, but offline, so an offer to all leaves them out",
  })
  offline!: string[];
  @ApiProperty({ example: false, description: "Installing it drops every template on the kiosks behind" })
  changesRecognition!: boolean;
  @ApiProperty({
    type: [String],
    example: [],
    description: "Kiosks it moves to another recognition model, offered only with the fleet",
  })
  recapture!: string[];
}

export class OfferStatusView {
  @ApiProperty({ example: "ae489569-fcc0-4393-9669-2d459d7c57bd", description: "Release offered" }) releaseId!: string;
  @ApiProperty({
    enum: ["FIRMWARE", "MODELS", "ASSETS"],
    enumName: "ReleaseTarget",
    example: "FIRMWARE",
    description: "Which partition the release installs to",
  })
  target!: string;
  @ApiProperty({ example: "0.9.2", description: "Version offered" }) version!: string;
  @ApiProperty({
    type: String,
    format: "date-time",
    example: "2026-09-20T03:15:00.000Z",
    description: "When it was offered",
  })
  offeredAt!: string;
  @ApiProperty({
    enum: ["WAITING", "INSTALLED", "TRIAL", "ROLLED_BACK", "FAILED", "INTERRUPTED", "EXPIRED"],
    enumName: "OfferState",
    example: "INSTALLED",
    description: "How the offer went, read from the kiosk's heartbeat and its events (KEHOACH 7.7)",
  })
  state!: string;
  @ApiProperty({
    type: String,
    nullable: true,
    example: "sha256 mismatch",
    description: "What the kiosk reported, for ROLLED_BACK and FAILED; null otherwise",
  })
  reason!: string | null;
  @ApiProperty({
    type: String,
    format: "date-time",
    nullable: true,
    example: "2026-09-20T03:25:00.000Z",
    description: "WAITING only: until when another offer to this kiosk is refused; null otherwise",
  })
  busyUntil!: string | null;
}

export class OfferAllView {
  @ApiProperty({ type: [String], example: ["kiosk-2884859fd3c8"], description: "Kiosks the offer was sent to" })
  offered!: string[];
  @ApiProperty({ type: [String], example: [], description: "Kiosks the offer could not be sent to" })
  failed!: string[];
  @ApiProperty({
    type: [String],
    example: ["kiosk-5c1a77e09b42"],
    description: "Kiosks still installing an earlier offer",
  })
  busy!: string[];
  @ApiProperty({ type: [String], example: ["kiosk-9e0b41d2c7aa"], description: "Kiosks offline, so not offered" })
  offline!: string[];
}

export class OfferView {
  @ApiProperty({ example: "kiosk-2884859fd3c8", description: "Kiosk the offer went to" }) deviceId!: string;
  @ApiProperty({
    type: String,
    format: "date-time",
    example: "2026-09-20T03:15:00.000Z",
    description: "When it was sent",
  })
  offeredAt!: Date;
}

export class PublishedView {
  @ApiProperty({ example: false, description: "The target and version are already on the register" })
  published!: boolean;
}

export class PublishResultView {
  @ApiProperty({ type: ReleaseViewDto, description: "The release as registered" }) release!: ReleaseViewDto;
  @ApiProperty({
    example: false,
    description: "The target and version were already on the register",
  })
  existing!: boolean;
}
