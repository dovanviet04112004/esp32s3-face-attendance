import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsEnum, IsInt, IsOptional, IsString, Max, MaxLength, Min } from "class-validator";

import { PaginationDto } from "../../../common/dto/pagination.dto.js";

const KINDS = ["EMPLOYMENT", "INCOME"] as const;
const STATES = ["REQUESTED", "ISSUED", "REJECTED"] as const;
const PURPOSE_MAX = 200;
const NOTE_MAX = 500;
const MONTHS_MIN = 1;
const MONTHS_MAX = 24;

export class AskCertificateDto {
  @ApiProperty({ enum: KINDS })
  @IsEnum(KINDS)
  kind!: (typeof KINDS)[number];

  @ApiProperty({ maxLength: PURPOSE_MAX, example: "Vay ngân hàng" })
  @IsString()
  @MaxLength(PURPOSE_MAX)
  purpose!: string;

  @ApiPropertyOptional({ minimum: MONTHS_MIN, maximum: MONTHS_MAX })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(MONTHS_MIN)
  @Max(MONTHS_MAX)
  months?: number;
}

export class DecideCertificateDto {
  @ApiPropertyOptional({ maxLength: NOTE_MAX })
  @IsOptional()
  @IsString()
  @MaxLength(NOTE_MAX)
  note?: string;
}

export class ListCertificatesDto extends PaginationDto {
  @ApiPropertyOptional({ enum: STATES })
  @IsOptional()
  @IsEnum(STATES)
  state?: (typeof STATES)[number];
}
