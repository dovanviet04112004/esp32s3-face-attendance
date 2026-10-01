import { ApiProperty, ApiPropertyOptional, IntersectionType } from "@nestjs/swagger";
import { IsString, MaxLength } from "class-validator";

import { BACKUP_CODE_COUNT } from "../totp.js";
import { SessionView } from "./login.dto.js";

const CHALLENGE_MAX = 2048;
const CODE_MAX = 32;
const CHALLENGE_EXAMPLE = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ0eXAiOiJtZmEifQ.c2ln";
const BACKUP_EXAMPLE = ["k7m2q-9xwdp", "a4hz8-r3nte"];

export class ChallengeDto {
  @ApiProperty({
    description: "The ticket POST /auth/login answered with; it lives MFA_CHALLENGE_MINUTES",
    maxLength: CHALLENGE_MAX,
    example: CHALLENGE_EXAMPLE,
  })
  @IsString()
  @MaxLength(CHALLENGE_MAX)
  challenge!: string;
}

export class CodeDto {
  @ApiProperty({
    description: "Six digits from the authenticator app, or one backup code; spaces and dashes are ignored",
    maxLength: CODE_MAX,
    example: "492039",
  })
  @IsString()
  @MaxLength(CODE_MAX)
  code!: string;
}

export class ChallengeCodeDto extends IntersectionType(ChallengeDto, CodeDto) {}

/** A secret on offer at enrolment; the page draws the QR itself (KEHOACH 9.4). */
export class MfaSetupView {
  @ApiProperty({ description: "The secret in base32, for typing into an app that cannot scan", example: "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP" })
  secret!: string;

  @ApiProperty({
    description: "The otpauth URI the QR carries",
    example: "otpauth://totp/app.example.com:hr%40example.com?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=app.example.com&algorithm=SHA1&digits=6&period=30",
  })
  uri!: string;
}

export class BackupCodesView {
  @ApiProperty({
    description: `The ${BACKUP_CODE_COUNT} backup codes, each good once; the server keeps only their hashes and never shows them again`,
    type: [String],
    example: BACKUP_EXAMPLE,
  })
  backupCodes!: string[];
}

export class EnrolledView extends SessionView {
  @ApiProperty({
    description: `The ${BACKUP_CODE_COUNT} backup codes, each good once; shown here and nowhere else`,
    type: [String],
    example: BACKUP_EXAMPLE,
  })
  backupCodes!: string[];
}

export class MfaStatusView {
  @ApiProperty({ description: "Whether this account's role signs in with a code (MFA_ROLES)", example: true })
  required!: boolean;

  @ApiPropertyOptional({ description: "When the authenticator was linked; null while none is", type: String, format: "date-time", nullable: true })
  enabledAt!: Date | null;

  @ApiProperty({ description: "Backup codes not used yet", example: 9 })
  backupCodesLeft!: number;
}
