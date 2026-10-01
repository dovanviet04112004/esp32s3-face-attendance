import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { NoticeChannel, NoticeKind } from "@prisma/client";
import { Transform } from "class-transformer";
import { IsBoolean, IsEnum, IsIn, IsOptional, IsString, MaxLength } from "class-validator";

export class SubscribeDto {
  @ApiProperty({
    example: "https://fcm.googleapis.com/fcm/send/dXJsOmV4YW1wbGU6c3Vic2NyaXB0aW9u",
    description: "The provider's endpoint; it is the key for this device",
  })
  @IsString()
  @MaxLength(512)
  endpoint!: string;

  @ApiProperty({
    example: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM",
    description: "The subscription's P-256 public key, base64url, as the browser hands it out",
  })
  @IsString()
  @MaxLength(256)
  p256dh!: string;

  @ApiProperty({ example: "tBHItJI5svbpez7KI4CCXg", description: "The subscription's auth secret, base64url" })
  @IsString()
  @MaxLength(256)
  auth!: string;

  @ApiPropertyOptional({
    example: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)",
    description: "Browser that subscribed, so a person can tell their devices apart",
  })
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
  @ApiProperty({ example: "0a113bd1-4a7b-4a3f-972b-bd493d497c2e", description: "Notice id (UUID)" })
  id!: string;

  @ApiProperty({ example: "ab35f74f-dd47-4ad6-8e4c-fb243e7ac176", description: "Account the notice is for" })
  userId!: string;

  @ApiProperty({
    enum: NoticeKind,
    enumName: "NoticeKind",
    example: NoticeKind.REQUEST_DECIDED,
    description: "What happened; the client turns it into a sentence",
  })
  kind!: NoticeKind;

  @ApiProperty({
    type: String,
    nullable: true,
    example: "e3bf5f75-3ad5-4aca-9258-33e4a3357956",
    description: "Request it is about; null otherwise",
  })
  requestId!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: "ee5e4c9f-9f5c-4ebd-8759-9b7ac5ed3696",
    description: "Salary advance it is about; null otherwise",
  })
  advanceId!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: "da693adb-e137-44a8-8b1d-2f89ad567a26",
    description: "Pay period whose payslips were issued; null otherwise",
  })
  periodId!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: "8f14e45f-ceea-467a-9575-7e4f3c2a1b90",
    description: "Payslip it is about; null otherwise",
  })
  payslipId!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: "467a1985-370a-4578-92e4-2b29e5f06535",
    description: "Contract nearing its end; null otherwise",
  })
  contractId!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: "6f6a9b24-645b-45fa-9376-4e2be3ae46a8",
    description: "Certificate it is about; null otherwise",
  })
  certificateId!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: "da693adb-e137-44a8-8b1d-2f89ad567a27",
    description: "Profile change it is about; null otherwise",
  })
  profileChangeId!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: "e71fa2d2-7ccc-4591-b9df-5b734e951e94",
    description: "Dependant registration it is about; null otherwise",
  })
  dependentId!: string | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    example: 30,
    description: "CONTRACT_ENDING only: days until the contract ends",
  })
  daysLeft!: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    example: 3,
    description: "REQUEST_STALLED only: whole days the item has waited",
  })
  daysWaited!: number | null;

  @ApiProperty({
    type: Boolean,
    nullable: true,
    example: true,
    description: "REQUEST_DECIDED only: whether it was approved",
  })
  approved!: boolean | null;

  @ApiProperty({
    type: String,
    format: "date-time",
    nullable: true,
    example: "2026-09-30T04:00:00.000Z",
    description: "When it was read; null while unread",
  })
  readAt!: Date | null;

  @ApiProperty({
    type: String,
    format: "date-time",
    example: "2026-09-30T03:12:45.000Z",
    description: "When it was raised",
  })
  createdAt!: Date;
}

export class UnreadView {
  @ApiProperty({ example: 3, description: "Notices not read yet" })
  total!: number;
}

export class PreferenceView {
  @ApiProperty({
    enum: NoticeKind,
    enumName: "NoticeKind",
    example: NoticeKind.PAYSLIP_ISSUED,
    description: "Kind of notice the switch is for",
  })
  kind!: NoticeKind;

  @ApiProperty({
    enum: [NoticeChannel.IN_APP, NoticeChannel.PUSH],
    enumName: "PreferenceChannel",
    example: NoticeChannel.PUSH,
    description: "Where it is delivered: the bell, or a push to the person's devices",
  })
  channel!: NoticeChannel;

  @ApiProperty({ example: true, description: "Whether this kind arrives on this channel" })
  on!: boolean;
}

export class SavedPreferenceView extends PreferenceView {
  @ApiProperty({ example: "ab35f74f-dd47-4ad6-8e4c-fb243e7ac176", description: "Account the switch belongs to" })
  userId!: string;

  @ApiProperty({
    type: String,
    format: "date-time",
    example: "2026-09-30T03:12:45.000Z",
    description: "When it was last set",
  })
  updatedAt!: Date;
}

export class SubscriptionView {
  @ApiProperty({ example: "4bb7fb6b-6b0f-42af-9b7a-2f2a5c7a23f7", description: "Subscription id (UUID)" })
  id!: string;

  @ApiProperty({ example: "ab35f74f-dd47-4ad6-8e4c-fb243e7ac176", description: "Account the device belongs to" })
  userId!: string;

  @ApiProperty({
    example: "https://fcm.googleapis.com/fcm/send/dXJsOmV4YW1wbGU6c3Vic2NyaXB0aW9u",
    description: "The provider's endpoint; the key for this device",
  })
  endpoint!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)",
    description: "Browser that subscribed; null if it did not say",
  })
  userAgent!: string | null;

  @ApiProperty({
    type: String,
    format: "date-time",
    example: "2026-09-02T01:00:00.000Z",
    description: "When it subscribed",
  })
  createdAt!: Date;

  @ApiProperty({
    type: String,
    format: "date-time",
    nullable: true,
    example: "2026-09-30T03:12:46.000Z",
    description: "When a push last went to it; null before any",
  })
  lastSentAt!: Date | null;
}

export class DoneView {
  @ApiProperty({ enum: [true], example: true, description: "Always true; a device not on record is already gone" })
  done!: true;
}

export class SweepView {
  @ApiProperty({ example: 2, description: "People told today" })
  told!: number;
}

export class SetPreferenceDto {
  @ApiProperty({
    enum: NoticeKind,
    enumName: "NoticeKind",
    example: NoticeKind.PAYSLIP_ISSUED,
    description: "Kind of notice to switch",
  })
  @IsEnum(NoticeKind)
  kind!: NoticeKind;

  // Only the channels somebody delivers can be switched (KEHOACH 9.21.4).
  @ApiProperty({
    enum: [NoticeChannel.IN_APP, NoticeChannel.PUSH],
    enumName: "PreferenceChannel",
    example: NoticeChannel.PUSH,
    description: "Where it is delivered: the bell, or a push to the person's devices",
  })
  @IsIn([NoticeChannel.IN_APP, NoticeChannel.PUSH])
  channel!: NoticeChannel;

  @ApiProperty({ example: false, description: "True delivers this kind on this channel, false stops it" })
  @IsBoolean()
  on!: boolean;
}
