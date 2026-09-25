import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { NoticeChannel, NoticeKind } from "@prisma/client";
import { Transform } from "class-transformer";
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

export class UnsubscribeQueryDto {
  // Left to the service, so a missing one answers PUSH_ENDPOINT_REQUIRED rather than validator prose.
  @ApiProperty({ description: "The endpoint of this device; nothing else is dropped" })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  endpoint?: string;
}

export class ListNoticesDto {
  // Boolean("false") is true, so a query string has to be compared, not cast.
  @ApiPropertyOptional({ description: "Only the ones not read yet" })
  @IsOptional()
  @Transform(({ value }) => value === true || value === "true")
  @IsBoolean()
  unread?: boolean;
}

export class NoticeView {
  @ApiProperty()
  id!: string;

  @ApiProperty({ enum: NoticeKind })
  kind!: NoticeKind;

  @ApiProperty({ nullable: true })
  requestId!: string | null;

  @ApiProperty({ nullable: true })
  advanceId!: string | null;

  @ApiProperty({ nullable: true })
  periodId!: string | null;

  @ApiProperty({ nullable: true })
  payslipId!: string | null;

  @ApiProperty({ nullable: true })
  contractId!: string | null;

  @ApiProperty({ nullable: true })
  certificateId!: string | null;

  @ApiProperty({ nullable: true })
  profileChangeId!: string | null;

  @ApiProperty({ nullable: true })
  dependentId!: string | null;

  @ApiProperty({ nullable: true })
  daysLeft!: number | null;

  @ApiProperty({ nullable: true })
  daysWaited!: number | null;

  @ApiProperty({ nullable: true })
  approved!: boolean | null;

  @ApiProperty({ nullable: true })
  readAt!: Date | null;

  @ApiProperty()
  createdAt!: Date;
}

export class UnreadView {
  @ApiProperty()
  total!: number;
}

export class PreferenceView {
  @ApiProperty({ enum: NoticeKind })
  kind!: NoticeKind;

  @ApiProperty({ enum: [NoticeChannel.IN_APP, NoticeChannel.PUSH] })
  channel!: NoticeChannel;

  @ApiProperty()
  on!: boolean;
}

export class SubscriptionView {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  endpoint!: string;

  @ApiProperty({ nullable: true })
  userAgent!: string | null;

  @ApiProperty()
  createdAt!: Date;
}

export class DoneView {
  @ApiProperty({ enum: [true] })
  done!: true;
}

export class SweepView {
  @ApiProperty({ description: "People told today" })
  told!: number;
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
