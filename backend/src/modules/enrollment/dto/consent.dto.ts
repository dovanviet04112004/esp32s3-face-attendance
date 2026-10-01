import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsIn, IsInt, IsOptional, IsString, MaxLength, Min } from "class-validator";

const METHODS = ["PORTAL", "KIOSK", "PAPER"] as const;

export class GrantConsentDto {
  @ApiPropertyOptional({ description: "Left out, the viewer agrees for themselves", example: 42 })
  @IsOptional()
  @IsInt()
  @Min(1)
  employeeId?: number;

  @ApiProperty({
    enum: METHODS,
    enumName: "ConsentMethod",
    description: "How it was given: on the portal, at a kiosk, or on paper the desk keeps",
    example: "PORTAL",
  })
  @IsIn([...METHODS])
  method!: (typeof METHODS)[number];

  @ApiPropertyOptional({ maxLength: 500, description: "Free note kept with the record", example: "Bản giấy lưu hồ sơ nhân sự" })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class ConsentView {
  @ApiProperty({ description: "Consent record id", example: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d" }) id!: string;
  @ApiProperty({ description: "Employee whose face data it covers", example: 42 }) employeeId!: number;
  @ApiProperty({ description: "The notice the server served when this was recorded", example: "2026-01-v1" })
  noticeVersion!: string;
  @ApiProperty({
    enum: ["GRANTED", "WITHDRAWN"],
    enumName: "ConsentState",
    description: "GRANTED while in force; WITHDRAWN once taken back",
  })
  state!: string;
  @ApiProperty({ enum: METHODS, enumName: "ConsentMethod", description: "How it was given" }) method!: string;
  @ApiProperty({ type: String, format: "date-time", description: "When it was given", example: "2026-09-01T02:30:00.000Z" })
  grantedAt!: string;
  @ApiProperty({
    type: String,
    format: "date-time",
    nullable: true,
    description: "When it was taken back; null while in force",
    example: "2026-09-25T04:00:00.000Z",
  })
  withdrawnAt!: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: "Account that recorded it: the person themselves, or the desk on their behalf",
    example: "b5f0c3d2-8a41-4e6b-9c2d-7f1e3a5b9c04",
  })
  recordedById!: string | null;
  @ApiProperty({ type: String, nullable: true, description: "Free note kept with the record" }) note!: string | null;
}

export class WithdrawnView {
  @ApiProperty({ type: ConsentView, description: "The record now withdrawn; the latest one when it already was" })
  consent!: ConsentView;
  @ApiProperty({ description: "Kiosks told to drop the face" }) devices!: number;
}
