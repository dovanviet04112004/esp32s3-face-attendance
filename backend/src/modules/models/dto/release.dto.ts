import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsEnum, IsOptional, IsString, Matches, MaxLength } from "class-validator";

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
