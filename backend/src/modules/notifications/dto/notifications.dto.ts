import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { NoticeChannel, NoticeKind } from "@prisma/client";
import { IsBoolean, IsEnum, IsOptional, IsString, MaxLength } from "class-validator";

export class SubscribeDto {
  @ApiProperty({ description: "The provider's endpoint; it is the key for this device" })
  @IsString()
  @MaxLength(512)
  endpoint!: string;

  @ApiProperty()
  @IsString()
  @MaxLength(256)
  p256dh!: string;

  @ApiProperty()
  @IsString()
  @MaxLength(256)
  auth!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(256)
  userAgent?: string;
}

export class SetPreferenceDto {
  @ApiProperty({ enum: NoticeKind })
  @IsEnum(NoticeKind)
  kind!: NoticeKind;

  @ApiProperty({ enum: NoticeChannel })
  @IsEnum(NoticeChannel)
  channel!: NoticeChannel;

  @ApiProperty()
  @IsBoolean()
  on!: boolean;
}
