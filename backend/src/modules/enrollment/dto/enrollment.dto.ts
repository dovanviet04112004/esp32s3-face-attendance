import { ApiProperty } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsInt, Matches, Min } from "class-validator";

const DEVICE_ID = /^[A-Za-z0-9_-]{4,32}$/;

export class AssignDto {
  @ApiProperty({ example: "kiosk-2884859fd3c8" })
  @Matches(DEVICE_ID)
  deviceId!: string;

  @ApiProperty({ example: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  employeeId!: number;
}

export class AssignableDeviceView {
  @ApiProperty() id!: string;
  @ApiProperty({ type: String, nullable: true }) name!: string | null;
  @ApiProperty({ type: String, nullable: true }) location!: string | null;
}

export class KioskStandingView extends AssignableDeviceView {
  @ApiProperty({ enum: ["ASSIGNED", "ENROLLED", "RETAKE", "REVOKED"] }) state!: string;
}

export class EnrollmentView {
  @ApiProperty() deviceId!: string;
  @ApiProperty() employeeId!: number;
  @ApiProperty({ enum: ["ASSIGNED", "ENROLLED", "RETAKE", "REVOKED"] }) state!: string;
  @ApiProperty({ type: Number, nullable: true }) templateIdx!: number | null;
}

export class RosterView {
  @ApiProperty({ description: "The roster version the kiosk reaches after the resync" }) rosterVersion!: number;
}
