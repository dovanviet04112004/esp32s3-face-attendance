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
