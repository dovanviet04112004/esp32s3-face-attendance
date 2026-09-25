import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Role } from "@prisma/client";
import { IsEmail, IsString, MinLength } from "class-validator";

export class LoginDto {
  @ApiProperty({ example: "admin@kiosk.local" })
  @IsEmail()
  email!: string;

  @ApiProperty({ minLength: 8 })
  @IsString()
  @MinLength(8)
  password!: string;
}

/** What a sign-in or a renewal answers; the refresh token rides in the cookie, never here. */
export class SessionView {
  @ApiProperty({ description: "Bearer token for every guarded route" })
  accessToken!: string;

  @ApiProperty({ description: "The signed-in account's address, as stored", example: "admin@kiosk.local" })
  email!: string;
}

export class ClaimsView {
  @ApiProperty({ description: "User id" })
  sub!: string;

  @ApiProperty({ enum: Role })
  role!: Role;

  @ApiProperty({ description: "Session row id" })
  sid!: string;

  @ApiPropertyOptional()
  employeeId?: number;

  @ApiProperty({ description: "Issued at, seconds since the epoch" })
  iat!: number;

  @ApiProperty({ description: "Expires at, seconds since the epoch" })
  exp!: number;
}
