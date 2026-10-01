import { ApiProperty, ApiPropertyOptional, IntersectionType } from "@nestjs/swagger";
import {
  NoticeChannel,
  NoticeItemState,
  NoticeKind,
  NoticeLevel,
  NoticeOutcome,
  NoticeQueue,
  NoticeSubject,
  RequestKind,
} from "@prisma/client";
import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from "class-validator";

import { CursorPageDto } from "../../../common/dto/pagination.dto.js";
import { PersonView } from "../../leave/dto/queue.dto.js";
import type { NoticeCategory } from "../notice-kinds.js";
import type { NoticeStatus } from "../notifications.service.js";

const STATUSES = ["unread", "action", "all", "archived"] as const satisfies readonly NoticeStatus[];
const CATEGORIES = ["REQUESTS", "PAY", "PEOPLE", "ATTENDANCE", "SYSTEM"] as const satisfies readonly NoticeCategory[];
const SEARCH_MAX = 64;
const ID_MAX = 64;
const MARK_MAX = 500;
const NOTE_MAX = 500;

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

/** What a reader narrows the bell to; every field narrows, none widens. */
export class NoticeFilterDto {
  @ApiPropertyOptional({
    enum: STATUSES,
    default: "all",
    description:
      "unread: not read, not put away, still held. action: open work the reader holds. all: everything not put away, moved rows included. archived: put away",
  })
  @IsOptional()
  @IsIn(STATUSES)
  status?: NoticeStatus;

  @ApiPropertyOptional({ enum: CATEGORIES, description: "The group a kind shows under, read off the kind table" })
  @IsOptional()
  @IsIn(CATEGORIES)
  category?: NoticeCategory;

  @ApiPropertyOptional({ example: "2026-09-01", description: "Raised on or after this day, in the business time zone" })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({ example: "2026-09-30", description: "Raised on or before this day, included" })
  @IsOptional()
  @IsDateString()
  to?: string;

  @ApiPropertyOptional({
    maxLength: SEARCH_MAX,
    description: "Code or name of the person a notice is about; only people the reader may still see match",
  })
  @IsOptional()
  @IsString()
  @MaxLength(SEARCH_MAX)
  search?: string;
}

export class ListNoticesDto extends IntersectionType(CursorPageDto, NoticeFilterDto) {}

export class NoticeSubjectRef {
  @ApiProperty({ enum: NoticeSubject, enumName: "NoticeSubject", example: NoticeSubject.REQUEST, description: "What kind of record" })
  @IsEnum(NoticeSubject)
  type!: NoticeSubject;

  @ApiProperty({ example: "e3bf5f75-3ad5-4aca-9258-33e4a3357956", description: "The record's id" })
  @IsString()
  @MaxLength(ID_MAX)
  id!: string;
}

/** Exactly one of ids, all or subject; the filter fields go with all (KEHOACH 9.21.4). */
export class MarkNoticesDto extends NoticeFilterDto {
  @ApiPropertyOptional({
    type: [String],
    maxItems: MARK_MAX,
    example: ["0a113bd1-4a7b-4a3f-972b-bd493d497c2e"],
    description: "These rows of the reader's; anybody else's id changes nothing",
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MARK_MAX)
  @IsString({ each: true })
  @MaxLength(ID_MAX, { each: true })
  ids?: string[];

  @ApiPropertyOptional({ enum: [true], description: "Every row the filter fields select, as the reader is looking at them" })
  @IsOptional()
  @IsIn([true])
  all?: true;

  @ApiPropertyOptional({ type: NoticeSubjectRef, description: "Every row about one record, as its page sends on opening" })
  @IsOptional()
  @ValidateNested()
  @Type(() => NoticeSubjectRef)
  subject?: NoticeSubjectRef;
}

export class NoticeItemView {
  @ApiProperty({ example: "requests:e3bf5f75-3ad5-4aca-9258-33e4a3357956", description: "The work's key: its queue and subject" })
  key!: string;

  @ApiProperty({ enum: NoticeLevel, enumName: "NoticeLevel", example: NoticeLevel.ACTION, description: "How loud the work is" })
  level!: NoticeLevel;

  @ApiProperty({
    enum: NoticeItemState,
    enumName: "NoticeItemState",
    example: NoticeItemState.DONE,
    description: "OPEN while it waits; any other state closed it for the whole group",
  })
  state!: NoticeItemState;

  @ApiProperty({
    enum: NoticeOutcome,
    enumName: "NoticeOutcome",
    nullable: true,
    example: NoticeOutcome.APPROVED,
    description: "The verb of the result, so the row can say approved by whom",
  })
  outcome!: NoticeOutcome | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: "Trần Thị B",
    description: "Who closed it: their name, or their email when the login has no employee record",
  })
  actorName!: string | null;

  @ApiProperty({
    type: String,
    format: "date-time",
    nullable: true,
    example: "2026-10-01T02:12:00.000Z",
    description: "When it closed; null while open",
  })
  closedAt!: Date | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: "Lê Thị C",
    description: "Who said they are on it; null when nobody is, or the claim has lapsed",
  })
  claimedByName!: string | null;

  @ApiProperty({
    type: String,
    format: "date-time",
    nullable: true,
    example: "2026-10-06T10:00:00.000Z",
    description: "When the work is due; null when it has no deadline",
  })
  dueAt!: Date | null;
}

export class SubjectRequestView {
  @ApiProperty({ enum: RequestKind, enumName: "RequestKind", example: RequestKind.LEAVE, description: "Kind of request" })
  kind!: RequestKind;

  @ApiProperty({ type: String, format: "date", example: "2026-10-03T00:00:00.000Z", description: "First day" })
  fromDate!: Date;

  @ApiProperty({ type: String, format: "date", example: "2026-10-04T00:00:00.000Z", description: "Last day, included" })
  toDate!: Date;

  @ApiProperty({ example: "2", description: "Days it charges, as a decimal string" })
  days!: string;

  @ApiProperty({
    nullable: true,
    example: { code: "AL", name: "Phép năm" },
    description: "The leave type, for a leave request; null otherwise",
  })
  leaveType!: { code: string; name: string } | null;
}

/** Who and what a notice is about, built when it is read, through the reader's scope (KEHOACH 9.21.4). */
export class NoticeSubjectView {
  @ApiProperty({ enum: NoticeSubject, enumName: "NoticeSubject", example: NoticeSubject.REQUEST, description: "What kind of record" })
  type!: NoticeSubject;

  @ApiProperty({
    type: String,
    nullable: true,
    example: "e3bf5f75-3ad5-4aca-9258-33e4a3357956",
    description: "The record; null when hidden",
  })
  id!: string | null;

  @ApiProperty({ example: false, description: "True once the reader may no longer see the person: no name, no way in" })
  hidden!: boolean;

  @ApiProperty({ type: PersonView, nullable: true, description: "The person it is about; null when hidden" })
  person!: PersonView | null;

  @ApiProperty({ type: SubjectRequestView, nullable: true, description: "The request's kind and days, for a request" })
  request!: SubjectRequestView | null;
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
    description:
      "REQUEST_DECIDED: whether it was approved; REQUEST_WAITING about an advance: true once approved, so it waits to be paid",
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

  @ApiProperty({ enum: CATEGORIES, example: "REQUESTS", description: "The group the kind shows under" })
  category!: NoticeCategory;

  @ApiProperty({
    type: String,
    nullable: true,
    example: "6b0f2f39-3c1e-4bbf-9a52-1f1bb5b8a1aa",
    description: "The shared item; null for news",
  })
  itemId!: string | null;

  @ApiProperty({ example: { daysWaited: 3 }, description: "Codes, numbers and days the kind table declares; never words or money" })
  facts!: Record<string, unknown>;

  @ApiProperty({ example: 0, description: "Times it surfaced again at a reminder mark" })
  remindCount!: number;

  @ApiProperty({
    type: String,
    format: "date-time",
    nullable: true,
    example: "2026-10-04T01:00:00.000Z",
    description: "When it last surfaced again; null before any reminder",
  })
  remindedAt!: Date | null;

  @ApiProperty({
    type: String,
    format: "date-time",
    nullable: true,
    example: null,
    description: "When the reader put it away; null while in the bell",
  })
  archivedAt!: Date | null;

  @ApiProperty({
    type: String,
    format: "date-time",
    nullable: true,
    example: null,
    description: "When the work moved to somebody else; the row then reads as moved and counts nowhere",
  })
  leftAt!: Date | null;

  @ApiProperty({ type: NoticeItemView, nullable: true, description: "The shared work this notice belongs to; null for news" })
  item!: NoticeItemView | null;

  @ApiProperty({ type: NoticeSubjectView, nullable: true, description: "What it is about; null when it names no record" })
  subject!: NoticeSubjectView | null;
}

export class NoticePageView {
  @ApiProperty({ type: [NoticeView], description: "The page, newest first" })
  rows!: NoticeView[];

  @ApiProperty({ example: 124, description: "Rows the filter selects, counted up to the ceiling" })
  total!: number;

  @ApiProperty({ example: true, description: "False when the total stopped at the ceiling" })
  totalIsExact!: boolean;

  @ApiProperty({ type: String, nullable: true, description: "Send as cursor for the next page; null on the last" })
  next!: string | null;
}

export class NoticeCountsView {
  @ApiProperty({ example: 3, description: "The bell: rows not read, not put away, still held" })
  unread!: number;

  @ApiProperty({ example: 2, description: "Needs you: open work the reader holds" })
  action!: number;

  @ApiProperty({ example: 0, description: "Open critical work the reader holds; an ADMIN's red dot" })
  critical!: number;
}

export class MarkedView extends NoticeCountsView {
  @ApiProperty({ example: 1, description: "Rows this call changed" })
  changed!: number;
}

export class HolderView {
  @ApiProperty({ type: String, nullable: true, example: "Trần Thị B", description: "Name, or email when the login has no record" })
  name!: string | null;

  @ApiProperty({ type: String, format: "date-time", nullable: true, example: null, description: "When they read it" })
  readAt!: Date | null;

  @ApiProperty({ type: String, format: "date-time", nullable: true, example: null, description: "When the work moved away from them" })
  leftAt!: Date | null;
}

export class NoticeItemDetailView {
  @ApiProperty({ example: "disputes:5d0f8a8e-6a43-4f2e-9e43-3b54b6bf3a10", description: "Queue and subject" })
  key!: string;

  @ApiProperty({ enum: NoticeQueue, enumName: "NoticeQueue", example: NoticeQueue.DISPUTES, description: "The queue it waits in" })
  queue!: NoticeQueue;

  @ApiProperty({ enum: NoticeLevel, enumName: "NoticeLevel", example: NoticeLevel.ACTION, description: "How loud the work is" })
  level!: NoticeLevel;

  @ApiProperty({ enum: NoticeItemState, enumName: "NoticeItemState", example: NoticeItemState.OPEN, description: "OPEN while it waits" })
  state!: NoticeItemState;

  @ApiProperty({ enum: NoticeOutcome, enumName: "NoticeOutcome", nullable: true, example: null, description: "Verb of the result" })
  outcome!: NoticeOutcome | null;

  @ApiProperty({ type: String, nullable: true, example: null, description: "Who closed it" })
  actorName!: string | null;

  @ApiProperty({ type: String, format: "date-time", example: "2026-10-01T02:00:00.000Z", description: "When it opened" })
  openedAt!: Date;

  @ApiProperty({ type: String, format: "date-time", nullable: true, example: null, description: "When it closed" })
  closedAt!: Date | null;

  @ApiProperty({ type: String, format: "date-time", nullable: true, example: null, description: "When it is due" })
  dueAt!: Date | null;

  @ApiProperty({ example: true, description: "Whether the group may say who is on it" })
  claimable!: boolean;

  @ApiProperty({ example: false, description: "Whether this reader may close it by hand, with a note" })
  resolvable!: boolean;

  @ApiProperty({ type: String, nullable: true, example: "Lê Thị C", description: "Who is on it; null when nobody, or lapsed" })
  claimedByName!: string | null;

  @ApiProperty({ type: String, format: "date-time", nullable: true, example: null, description: "When they said so" })
  claimedAt!: Date | null;

  @ApiProperty({ type: NoticeSubjectView, nullable: true, description: "What it is about, through the reader's scope" })
  subject!: NoticeSubjectView | null;

  @ApiProperty({
    type: [HolderView],
    nullable: true,
    description: "Whom it reached and who has read it; only the group and ADMIN, never the person it is about",
  })
  holders!: HolderView[] | null;
}

export class ResolveItemDto {
  @ApiProperty({
    maxLength: NOTE_MAX,
    example: "Gia hạn bằng phụ lục số 3",
    description: "How it ended, for the group and the audit trail",
  })
  @IsString()
  @MaxLength(NOTE_MAX)
  note!: string;
}

const SWEEPS = ["reconcile", "stalled", "contracts", "probation", "backup", "cleanup"] as const;

export type SweepName = (typeof SWEEPS)[number];

export class SweepParamDto {
  @ApiProperty({ enum: SWEEPS, description: "Which sweep to run now; each also runs on its own schedule" })
  @IsIn(SWEEPS)
  name!: SweepName;
}

export class SweepRunView {
  @ApiProperty({ enum: SWEEPS, example: "reconcile", description: "The sweep that ran" })
  name!: SweepName;

  @ApiProperty({
    type: Object,
    example: { REQUESTS: { closed: 0, opened: 0, joined: 1, left: 0 } },
    description: "What the sweep reports; its shape is the sweep's own",
  })
  result!: Record<string, unknown>;
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

export class OfferedPreferenceView extends PreferenceView {
  @ApiProperty({ example: true, description: "False for a work item's in-app switch, which stays on" })
  mutable!: boolean;
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
