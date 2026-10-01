import { ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from "class-validator";

import { MAX_OFFSET } from "./cursor.dto.js";

const MAX_PAGE_SIZE = 200;
const MAX_CURSOR_LENGTH = 256;

class PageSizeDto {
  @ApiPropertyOptional({ minimum: 1, maximum: MAX_PAGE_SIZE, default: 50, description: "Most rows the page holds" })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  take: number = 50;
}

/** Paging for a list that only resumes after the row a page ended on. */
export class CursorPageDto extends PageSizeDto {
  @ApiPropertyOptional({ description: "Resume after the row the last page ended on" })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_CURSOR_LENGTH)
  cursor?: string;
}

/** Paging for a list that only counts rows off the top, so a pager can number its pages. */
export class OffsetPageDto extends PageSizeDto {
  @ApiPropertyOptional({
    minimum: 0,
    maximum: MAX_OFFSET,
    default: 0,
    description: "Rows to pass over before the page starts",
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(MAX_OFFSET)
  skip: number = 0;
}

/** Paging for a list that takes either: an offset for a shallow page, a cursor to go deep (KEHOACH 9.9 rule 3). */
export class PaginationDto extends CursorPageDto {
  @ApiPropertyOptional({
    minimum: 0,
    maximum: MAX_OFFSET,
    default: 0,
    description: "Rows to pass over before the page starts; ignored when a cursor is sent",
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(MAX_OFFSET)
  skip: number = 0;
}

/** One page of rows, a total the pager can size itself from, and the cursor
 *  that resumes it. An absent `totalIsExact` means the total is exact.
 */
export interface Page<T> {
  rows: T[];
  total: number;
  totalIsExact?: boolean;
  next?: string | null;
}
