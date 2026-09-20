import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsIn, IsOptional, IsString, MaxLength } from "class-validator";

import { PaginationDto } from "../../../common/dto/pagination.dto.js";
import { AUDIT_ACTIONS, AUDIT_SUBJECTS, type AuditAction, type AuditSubject } from "../audit-actions.js";

const SUBJECTS = Object.values(AUDIT_SUBJECTS);
const ACTIONS = Object.values(AUDIT_ACTIONS);
const ID_MAX = 128;

export class AuditQueryDto extends PaginationDto {
  @ApiPropertyOptional({ enum: SUBJECTS })
  @IsOptional()
  @IsIn(SUBJECTS)
  subjectType?: AuditSubject;

  @ApiPropertyOptional({ example: "412" })
  @IsOptional()
  @IsString()
  @MaxLength(ID_MAX)
  subjectId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(ID_MAX)
  actorId?: string;

  @ApiPropertyOptional({ enum: ACTIONS })
  @IsOptional()
  @IsIn(ACTIONS)
  action?: AuditAction;
}
