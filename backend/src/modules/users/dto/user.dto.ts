import { ApiProperty, ApiPropertyOptional, PartialType } from "@nestjs/swagger";
import { IsEmail, IsEnum, IsOptional, IsString, MinLength } from "class-validator";

const ROLES = ["ADMIN", "HR", "VIEWER"] as const;
const MIN_PASSWORD = 12;

export class CreateUserDto {
  @ApiProperty({ example: "hr@kiosk.local" })
  @IsEmail()
  email!: string;

  @ApiProperty({ minLength: MIN_PASSWORD })
  @IsString()
  @MinLength(MIN_PASSWORD)
  password!: string;

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
