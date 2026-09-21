import { ApiProperty, ApiPropertyOptional, PartialType } from "@nestjs/swagger";
import { IsEmail, IsEnum, IsOptional } from "class-validator";

const ROLES = ["ADMIN", "HR", "VIEWER"] as const;

export class CreateUserDto {
  @ApiProperty({ example: "hr@kiosk.local" })
  @IsEmail()
  email!: string;

  @ApiProperty({ enum: ROLES })
  @IsEnum(ROLES)
  role!: (typeof ROLES)[number];
}

export class UpdateUserDto extends PartialType(CreateUserDto) {
  @ApiPropertyOptional({ enum: ROLES })
  @IsOptional()
  @IsEnum(ROLES)
  role?: (typeof ROLES)[number];
}
