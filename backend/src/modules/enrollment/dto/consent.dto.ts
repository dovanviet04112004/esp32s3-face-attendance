import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsIn, IsInt, IsOptional, IsString, MaxLength, Min } from "class-validator";

const METHODS = ["PORTAL", "KIOSK", "PAPER"] as const;

export class GrantConsentDto {
  @ApiPropertyOptional({ description: "Left out, the viewer agrees for themselves" })
  @IsOptional()
  @IsInt()
  @Min(1)
  employeeId?: number;

  @ApiProperty({ enum: METHODS, example: "PORTAL" })
  @IsIn([...METHODS])
  method!: (typeof METHODS)[number];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class ConsentView {
  @ApiProperty() id!: string;
  @ApiProperty() employeeId!: number;
  @ApiProperty({ description: "The notice the server served when this was recorded" }) noticeVersion!: string;
  @ApiProperty({ enum: ["GRANTED", "WITHDRAWN"] }) state!: string;
  @ApiProperty({ enum: METHODS }) method!: string;
  @ApiProperty() grantedAt!: string;
  @ApiProperty({ type: String, nullable: true }) withdrawnAt!: string | null;
  @ApiProperty({ type: String, nullable: true }) note!: string | null;
}

export class WithdrawnView {
  @ApiProperty({ type: ConsentView }) consent!: ConsentView;
  @ApiProperty({ description: "Kiosks told to drop the face" }) devices!: number;
}
