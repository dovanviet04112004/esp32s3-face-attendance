import { ApiProperty } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsInt, Matches, Min } from "class-validator";

export const DEVICE_ID = /^[A-Za-z0-9_-]{4,32}$/;

const ENROLLMENT_STATES = ["ASSIGNED", "ENROLLED", "RETAKE", "REVOKED"];

export class AssignDto {
  @ApiProperty({ example: "kiosk-2884859fd3c8", description: "Approved kiosk to put the person on" })
  @Matches(DEVICE_ID)
  deviceId!: string;

  @ApiProperty({ example: 1, description: "Employee to put on it; their biometric consent must be in force" })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  employeeId!: number;
}

export class AssignableDeviceView {
  @ApiProperty({ example: "kiosk-2884859fd3c8", description: "Kiosk id" }) id!: string;
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
}

export class KioskStandingView extends AssignableDeviceView {
  @ApiProperty({
    enum: ENROLLMENT_STATES,
    enumName: "EnrollmentState",
    example: "ENROLLED",
    description: "ASSIGNED waits for a face, ENROLLED holds one, RETAKE holds one while a new capture is asked for",
  })
  state!: string;
}

export class EnrollmentView {
  @ApiProperty({ example: "kiosk-2884859fd3c8", description: "Kiosk id" }) deviceId!: string;
  @ApiProperty({ example: 42, description: "Employee id" }) employeeId!: number;
  @ApiProperty({
    enum: ENROLLMENT_STATES,
    enumName: "EnrollmentState",
    example: "ASSIGNED",
    description: "ASSIGNED waits for a face, ENROLLED holds one, RETAKE asks for a new one, REVOKED was withdrawn",
  })
  state!: string;
  @ApiProperty({
    type: Number,
    nullable: true,
    example: 0,
    description: "Template slot of the person's newest sample on this kiosk; null before any",
  })
  templateIdx!: number | null;
  @ApiProperty({
    type: String,
    format: "date-time",
    nullable: true,
    example: "2026-09-20T02:31:05.000Z",
    description: "Capture session this kiosk opened, as the kiosk stamped it; null before a capture here",
  })
  sessionAt!: string | null;
  @ApiProperty({
    type: String,
    format: "date-time",
    nullable: true,
    example: "2026-09-20T02:31:06.000Z",
    description: "When the server heard that session's first sample; later ones count within ENROLL_SESSION_MINUTES",
  })
  sessionOpenedAt!: string | null;
  @ApiProperty({
    type: String,
    format: "date-time",
    example: "2026-09-20T02:31:06.000Z",
    description: "When the row last changed",
  })
  updatedAt!: string;
}

export class RosterView {
  @ApiProperty({
    example: 58,
    description: "The roster version the kiosk reaches after the resync",
  })
  rosterVersion!: number;
}
