import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { NoticeChannel, NoticeKind } from "@prisma/client";
import { IsBoolean, IsEnum, IsIn, IsOptional, IsString, MaxLength } from "class-validator";

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

  // Only the channels somebody delivers can be switched (KEHOACH 9.21.4).
  @ApiProperty({ enum: [NoticeChannel.IN_APP, NoticeChannel.PUSH] })
  @IsIn([NoticeChannel.IN_APP, NoticeChannel.PUSH])
  channel!: NoticeChannel;

  @ApiProperty()
  @IsBoolean()
  on!: boolean;
}
