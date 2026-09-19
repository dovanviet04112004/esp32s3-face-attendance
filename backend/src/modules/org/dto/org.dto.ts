import { ApiProperty, ApiPropertyOptional, PartialType } from "@nestjs/swagger";
import { IsBoolean, IsInt, IsOptional, IsString, MaxLength, MinLength } from "class-validator";

export class CreateDepartmentDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  legalEntityId!: string;

  @ApiProperty({ example: "PB0001", maxLength: 32 })
  @IsString()
  @MinLength(1)
  @MaxLength(32)
  code!: string;

  @ApiProperty({ example: "Kỹ thuật", maxLength: 128 })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  name!: string;

  @ApiPropertyOptional({ description: "Null for a top-level department" })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  parentId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(32)
  costCentre?: string;

  @ApiPropertyOptional({ description: "Employee id of the person heading it" })
  @IsOptional()
  @IsInt()
  headId?: number;
}

export class UpdateDepartmentDto extends PartialType(CreateDepartmentDto) {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
