import { ApiProperty } from "@nestjs/swagger";
import { IsEmail, IsString, MaxLength, MinLength } from "class-validator";

const TOKEN_MAX = 128;
const PASSWORD_MIN = 12;
const PASSWORD_MAX = 200;
const EMAIL_MAX = 254;

export class SetPasswordDto {
  @ApiProperty({
    description: "The one-use token from the set-password link in the mail; it expires and works once",
    maxLength: TOKEN_MAX,
    example: "Yk2vR8pQe1xWm4tN7sLc0aZb3dF6gH9jK5uI2oP8yT1",
  })
  @IsString()
  @MaxLength(TOKEN_MAX)
  token!: string;

  @ApiProperty({
    description: "The new password",
    minLength: PASSWORD_MIN,
    maxLength: PASSWORD_MAX,
    example: "mat-khau-moi-du-dai",
  })
  @IsString()
  @MinLength(PASSWORD_MIN)
  @MaxLength(PASSWORD_MAX)
  password!: string;
}

/** Changing one asks for the one in hand, so a stolen session cannot lock the
 *  owner out of their own account (KEHOACH 9.4).
 */
export class ChangePasswordDto {
  @ApiProperty({
    description: "The password the account has now",
    minLength: PASSWORD_MIN,
    maxLength: PASSWORD_MAX,
    example: "mat-khau-dang-dung",
  })
  @IsString()
  @MaxLength(PASSWORD_MAX)
  current!: string;

  @ApiProperty({
    description: "The password to set; every session, this one included, ends once it is saved",
    minLength: PASSWORD_MIN,
    maxLength: PASSWORD_MAX,
    example: "mat-khau-moi-du-dai",
  })
  @IsString()
  @MinLength(PASSWORD_MIN)
  @MaxLength(PASSWORD_MAX)
  next!: string;
}

export class ForgotPasswordDto {
  @ApiProperty({
    description: "The address to send a set-password link to; the answer is the same whether or not it has an account",
    example: "nv0001@example.com",
  })
  @IsEmail()
  @MaxLength(EMAIL_MAX)
  email!: string;
}
