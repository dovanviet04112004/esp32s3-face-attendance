import { ApiProperty } from "@nestjs/swagger";
import { IsEmail, IsString, MaxLength, MinLength } from "class-validator";

const TOKEN_MAX = 128;
const PASSWORD_MIN = 12;
const PASSWORD_MAX = 200;
const EMAIL_MAX = 254;

export class SetPasswordDto {
  @ApiProperty({ maxLength: TOKEN_MAX })
  @IsString()
  @MaxLength(TOKEN_MAX)
  token!: string;

  @ApiProperty({ minLength: PASSWORD_MIN, maxLength: PASSWORD_MAX })
  @IsString()
  @MinLength(PASSWORD_MIN)
  @MaxLength(PASSWORD_MAX)
  password!: string;
}

/** Changing one asks for the one in hand, so a stolen session cannot lock the
 *  owner out of their own account (KEHOACH 9.4).
 */
export class ChangePasswordDto {
  @ApiProperty({ minLength: PASSWORD_MIN, maxLength: PASSWORD_MAX })
  @IsString()
  @MaxLength(PASSWORD_MAX)
  current!: string;

  @ApiProperty({ minLength: PASSWORD_MIN, maxLength: PASSWORD_MAX })
  @IsString()
  @MinLength(PASSWORD_MIN)
  @MaxLength(PASSWORD_MAX)
  next!: string;
}

export class ForgotPasswordDto {
  @ApiProperty({ example: "nv0001@example.com" })
  @IsEmail()
  @MaxLength(EMAIL_MAX)
  email!: string;
}
