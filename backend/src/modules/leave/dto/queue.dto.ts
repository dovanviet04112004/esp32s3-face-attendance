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
  @ApiProperty({ example: "6aef5afe-433e-4daa-9ece-c33b41d3a660", description: "Department id (UUID)" })
  id!: string;

  @ApiProperty({ example: "Kỹ thuật", description: "Department name as the org chart shows it" })
  name!: string;
}

/** Who a queue row is about. */
export class PersonView {
  @ApiProperty({ example: 42, description: "Employee id" })
  id!: number;

  @ApiProperty({ example: "NV0042", description: "Employee code" })
  code!: string;

  @ApiProperty({ example: "Nguyễn Văn An", description: "Name as on the employee record" })
  fullName!: string;

  @ApiProperty({ type: DepartmentRef, nullable: true, description: "Where the person sits; null when unplaced" })
  department!: DepartmentRef | null;
}

/** The account that decided something, and the person behind it if any. */
export class DeciderView {
  @ApiProperty({ example: "ab35f74f-dd47-4ad6-8e4c-fb243e7ac176", description: "Account id (UUID)" })
  id!: string;

  @ApiProperty({ example: "manager@kiosk.local", description: "Sign-in email of the account" })
  email!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: "Vũ Thị Quản Lý",
    description: "Name of the employee behind the account; null for an account without one",
  })
  fullName!: string | null;
}

export class PageMeta {
  @ApiProperty({ example: 120, description: "Stops at the count ceiling; see totalIsExact" })
  total!: number;

  @ApiProperty({ example: true, description: "False when counting stopped at the ceiling, so total is a floor" })
  totalIsExact!: boolean;

  @ApiProperty({
    type: String,
    nullable: true,
    example: "eyJzb3J0VmFsdWUiOiIyMDI2LTA5LTE0VDAxOjMyOjA1LjAwMFoiLCJpZCI6IjhmMTRlNDVmLWNlZWEtNDY3YS05NTc1LTdlNGYzYzJhMWI5MCJ9",
    description: "Pass as cursor for the next page; null once a page comes back short",
  })
  next!: string | null;
}
