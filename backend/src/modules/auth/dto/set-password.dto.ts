import { ApiProperty } from "@nestjs/swagger";
import { IsString, MaxLength, MinLength } from "class-validator";

const TOKEN_MAX = 128;
const PASSWORD_MIN = 12;
const PASSWORD_MAX = 200;

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
