import { ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from "class-validator";

import { MAX_OFFSET } from "./cursor.dto.js";

const MAX_PAGE_SIZE = 200;
const MAX_CURSOR_LENGTH = 256;

export class PaginationDto {
  @ApiPropertyOptional({ minimum: 0, maximum: MAX_OFFSET, default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(MAX_OFFSET)
  skip: number = 0;

  @ApiPropertyOptional({ description: "Resume after the row the last page ended on" })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_CURSOR_LENGTH)
  cursor?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: MAX_PAGE_SIZE, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  take: number = 50;
}

/** One page of rows, the total so a table can size its pager, and the cursor
 *  that resumes it; `next` is null on the last page.
 */
export interface Page<T> {
  rows: T[];
  total: number;
  next?: string | null;
}
