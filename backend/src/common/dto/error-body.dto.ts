import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

/** The one shape every error answer takes; `message` is a code the client turns into a sentence (CLAUDE.md 3.1). */
export class ErrorBody {
  @ApiProperty({ example: 400 })
  statusCode!: number;

  @ApiProperty({ description: "UPPER_SNAKE code, never a sentence", example: "VALIDATION_FAILED" })
  message!: string;

  @ApiPropertyOptional({
    type: [String],
    description: "The request properties that failed; only with VALIDATION_FAILED",
    example: ["email", "rows.3.code"],
  })
  fields?: string[];

  @ApiProperty({ example: "/auth/login" })
  path!: string;

  @ApiProperty({ format: "date-time" })
  ts!: string;
}
