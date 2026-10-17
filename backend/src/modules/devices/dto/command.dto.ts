import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsIn, IsInt, IsObject, IsOptional } from "class-validator";

import { deviceCmdSchema } from "../../../common/generated/device_cmd.js";
import type { CommandAsk } from "../commands.service.js";

const COMMAND_ACTIONS = deviceCmdSchema.shape.action.options;
const COMMAND_STATES = ["QUEUED", "SENT", "DONE", "REJECTED", "EXPIRED"] as const;

/** What a person asks a kiosk to do; the values are checked against contracts/schema/device_cmd.schema.json. */
export class SendCommandDto {
  @ApiProperty({ enum: COMMAND_ACTIONS, enumName: "CommandAction", example: "OPEN_DOOR", description: "What the kiosk does" })
  @IsIn(COMMAND_ACTIONS)
  action!: CommandAsk["action"];

  @ApiPropertyOptional({ example: 3000, description: "OPEN_DOOR only: how long the door stays released, in ms" })
  @IsOptional()
  @IsInt()
  openMs?: number;

  @ApiPropertyOptional({ enum: [0, 1], example: 1, description: "SET_ACTIVE_SLOT only: the models slot to boot next" })
  @IsOptional()
  @IsInt()
  activeSlot?: 0 | 1;

  @ApiPropertyOptional({
    type: "object",
    additionalProperties: true,
    example: { dedupWindowMinutes: 10, brightness: 80 },
    description:
      "SET_CONFIG only: brightness, volume, lang, dedupWindowMinutes, faceMinPx, wakeDistanceCm, bounded by the contract; an absent one stays",
  })
  @IsOptional()
  @IsObject()
  config?: CommandAsk["config"];
}

export class CommandView {
  @ApiProperty({ example: "5b1c0f7e-3a4d-4e1f-9c2b-8d7e6f5a4b3c", description: "The id the kiosk answers with" }) cmdId!: string;
  @ApiProperty({ enum: COMMAND_ACTIONS, enumName: "CommandAction", example: "OPEN_DOOR", description: "What was asked" })
  action!: string;
  @ApiProperty({ type: "object", additionalProperties: true, example: { openMs: 3000 }, description: "The fields the command carried" })
  payload!: object;
  @ApiProperty({ enum: COMMAND_STATES, enumName: "CommandState", example: "DONE", description: "Where it stands, read now" })
  state!: string;
  @ApiProperty({ type: String, nullable: true, example: "door held 3000 ms", description: "What the kiosk said back" })
  resultNote!: string | null;
  @ApiProperty({ type: String, nullable: true, example: "Đỗ Văn Việt", description: "Who sent it; null once the login is gone" })
  issuedBy!: string | null;
  @ApiProperty({ type: Date, nullable: true, description: "When the kiosk stops taking it" }) expiresAt!: Date | null;
  @ApiProperty({ description: "When it was sent" }) createdAt!: Date;
  @ApiProperty({ description: "When it last changed" }) updatedAt!: Date;
}
