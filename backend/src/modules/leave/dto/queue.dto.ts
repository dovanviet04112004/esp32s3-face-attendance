import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsDateString, IsIn, IsOptional, IsString, MaxLength } from "class-validator";

import { PaginationDto } from "../../../common/dto/pagination.dto.js";

export const ORDERS = ["asc", "desc"] as const;
export type Order = (typeof ORDERS)[number];

const SEARCH_MAX = 64;
const ID_MAX = 64;

/** The filters every queue and ledger of the inbox takes (KEHOACH 9.10). */
export class QueueQueryDto extends PaginationDto {
  @ApiPropertyOptional({ maxLength: SEARCH_MAX, description: "Employee code or full name, any case" })
  @IsOptional()
  @IsString()
  @MaxLength(SEARCH_MAX)
  search?: string;

  @ApiPropertyOptional({ description: "This department and every department under it" })
  @IsOptional()
  @IsString()
  @MaxLength(ID_MAX)
  departmentId?: string;

  @ApiPropertyOptional({ example: "2026-09-01", description: "First day, in the business time zone" })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({ example: "2026-09-30", description: "Last day, included" })
  @IsOptional()
  @IsDateString()
  to?: string;

  @ApiPropertyOptional({ enum: ORDERS, description: "On the filing time, id breaking ties" })
  @IsOptional()
  @IsIn(ORDERS)
  order?: Order;
}

export class DepartmentRef {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  name!: string;
}

/** Who a queue row is about. */
export class PersonView {
  @ApiProperty()
  id!: number;

  @ApiProperty()
  code!: string;

  @ApiProperty()
  fullName!: string;

  @ApiProperty({ type: DepartmentRef, nullable: true })
  department!: DepartmentRef | null;
}

/** The account that decided something, and the person behind it if any. */
export class DeciderView {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  email!: string;

  @ApiProperty({ nullable: true })
  fullName!: string | null;
}

export class PageMeta {
  @ApiProperty({ description: "Stops at the count ceiling; see totalIsExact" })
  total!: number;

  @ApiProperty()
  totalIsExact!: boolean;

  @ApiProperty({ nullable: true, description: "Pass as cursor for the next page" })
  next!: string | null;
}
