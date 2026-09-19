import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsEnum, IsInt, IsOptional, IsString, Matches, MaxLength, Min } from "class-validator";

const TARGETS = ["FIRMWARE", "MODELS", "ASSETS"] as const;
const SEMVER = /^\d+\.\d+\.\d+$/;

export class CreateReleaseDto {
  @ApiProperty({ enum: TARGETS })
  @IsEnum(TARGETS)
  target!: (typeof TARGETS)[number];

  @ApiProperty({ example: "0.9.1" })
  @Matches(SEMVER, { message: "version must read MAJOR.MINOR.PATCH so it can be ordered" })
  version!: string;

  @ApiProperty({ example: "https://example.com/0.9.1/face_attendance.bin" })
  @Matches(/^https:\/\//, { message: "url must be https" })
  @MaxLength(512)
  url!: string;

  @ApiProperty({ example: "8e3ee4670e0c27e5db9b2c2cef72bc6ae8300fad246df77993dde5bc6f79e110" })
  @Matches(/^[0-9a-f]{64}$/, { message: "sha256 must be 64 lowercase hex digits" })
  sha256!: string;

  @ApiProperty({ example: 1794912 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  sizeBytes!: number;

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
