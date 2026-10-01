import { Body, Controller, Delete, Get, HttpStatus, Param, Post, Query, UseGuards } from "@nestjs/common";
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from "@nestjs/swagger";
import type { NotificationPreference } from "@prisma/client";

import { RateBucket } from "../../common/decorators/rate-bucket.decorator.js";
import { Roles } from "../../common/decorators/roles.decorator.js";
import type { Page } from "../../common/dto/pagination.dto.js";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard.js";
import { RolesGuard } from "../../common/guards/roles.guard.js";
import { CurrentViewer, type Viewer } from "../../common/scope/viewer.js";
import { API_AUTH, ApiErrors } from "../../common/decorators/api-docs.decorator.js";
import { ErrorBody } from "../../common/dto/error-body.dto.js";
import {
  DoneView,
  ListNoticesDto,
  MarkedView,
  MarkNoticesDto,
  NoticeCountsView,
  NoticeItemDetailView,
  NoticePageView,
  NoticeView,
  OfferedPreferenceView,
  ResolveItemDto,
  SavedPreferenceView,
  SetPreferenceDto,
  SubscribeDto,
  SubscriptionView,
  SweepParamDto,
  SweepRunView,
  UnreadView,
  UnsubscribeQueryDto,
} from "./dto/notifications.dto.js";
import { THROTTLE } from "../auth/auth.types.js";
import { BackupWatchService } from "./backup-watch.service.js";
import { ContractAlertsService } from "./contract-alerts.service.js";
import { NoticeItemsService, type ItemDetail } from "./notice-items.service.js";
import {
  NotificationsService,
  type MarkAction,
  type NoticeCounts,
  type NoticeRow,
  type PreferenceRow,
  type SubscriptionView as KeptSubscription,
  type Unread,
} from "./notifications.service.js";
import { StaleRequestsService } from "./stale-requests.service.js";
import { ReconcileSweep } from "./sweeps/reconcile.sweep.js";

const NOTICE_ID = { name: "id", description: "Notice id (UUID)", example: "0a113bd1-4a7b-4a3f-972b-bd493d497c2e" };
const ITEM_KEY = {
  name: "key",
  description: "Item key: the queue in kebab case and the subject id",
  example: "disputes:5d0f8a8e-6a43-4f2e-9e43-3b54b6bf3a10",
};

@ApiTags("notifications")
@ApiBearerAuth(API_AUTH.user)
@ApiErrors(HttpStatus.UNAUTHORIZED)
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller("notifications")
export class NotificationsController {
  constructor(
    private readonly notices: NotificationsService,
    private readonly items: NoticeItemsService,
    private readonly alerts: ContractAlertsService,
    private readonly stale: StaleRequestsService,
    private readonly backups: BackupWatchService,
    private readonly reconcile: ReconcileSweep,
  ) {}

  @Get()
  @ApiOperation({ summary: "The reader's notices under a filter, newest first, each with its work's state and its subject" })
  @ApiOkResponse({ type: NoticePageView })
  @ApiBadRequestResponse({ type: ErrorBody, description: "CURSOR_INVALID, or a filter field the server refuses" })
  list(@CurrentViewer() viewer: Viewer, @Query() query: ListNoticesDto): Promise<Page<NoticeRow>> {
    return this.notices.list(viewer, query);
  }

  @Get("counts")
  @ApiOperation({ summary: "The bell's three numbers: unread, open work held, open critical work held" })
  @ApiOkResponse({ type: NoticeCountsView })
  counts(@CurrentViewer() viewer: Viewer): Promise<NoticeCounts> {
    return this.notices.counts(viewer.userId);
  }

  @Get("unread")
  @ApiOperation({ summary: "The bell's number alone; counts.unread is the same and this goes in the release after" })
  @ApiOkResponse({ type: UnreadView })
  unread(@CurrentViewer() viewer: Viewer): Promise<Unread> {
    return this.notices.unread(viewer.userId);
  }

  @Post("read")
  @ApiOperation({ summary: "Mark rows read: by ids, every row of a filter, or every row about one record" })
  @ApiCreatedResponse({ type: MarkedView })
  @ApiBadRequestResponse({ type: ErrorBody, description: "SELECTION_INVALID unless exactly one of ids, all and subject" })
  read(@CurrentViewer() viewer: Viewer, @Body() body: MarkNoticesDto): Promise<NoticeCounts & { changed: number }> {
    return this.mark(viewer, "read", body);
  }

  @Post("unread")
  @ApiOperation({ summary: "Mark rows unread again, named the same three ways" })
  @ApiCreatedResponse({ type: MarkedView })
  @ApiBadRequestResponse({ type: ErrorBody, description: "SELECTION_INVALID unless exactly one of ids, all and subject" })
  unreadAgain(@CurrentViewer() viewer: Viewer, @Body() body: MarkNoticesDto): Promise<NoticeCounts & { changed: number }> {
    return this.mark(viewer, "unread", body);
  }

  @Post("archive")
  @ApiOperation({ summary: "Put rows away: they leave the bell, while open work stays in the inbox and is still reminded" })
  @ApiCreatedResponse({ type: MarkedView })
  @ApiBadRequestResponse({ type: ErrorBody, description: "SELECTION_INVALID unless exactly one of ids, all and subject" })
  archive(@CurrentViewer() viewer: Viewer, @Body() body: MarkNoticesDto): Promise<NoticeCounts & { changed: number }> {
    return this.mark(viewer, "archive", body);
  }

  @Post("unarchive")
  @ApiOperation({ summary: "Bring rows put away back into the bell" })
  @ApiCreatedResponse({ type: MarkedView })
  @ApiBadRequestResponse({ type: ErrorBody, description: "SELECTION_INVALID unless exactly one of ids, all and subject" })
  unarchive(@CurrentViewer() viewer: Viewer, @Body() body: MarkNoticesDto): Promise<NoticeCounts & { changed: number }> {
    return this.mark(viewer, "unarchive", body);
  }

  @Post("sweeps/:name")
  @RateBucket(THROTTLE.heavy)
  @Roles("ADMIN")
  @ApiOperation({ summary: "Run one sweep now; each also runs on its own schedule" })
  @ApiCreatedResponse({ type: SweepRunView })
  async sweep(@Param() params: SweepParamDto): Promise<SweepRunView> {
    const run = {
      reconcile: () => this.reconcile.sweep(),
      stalled: () => this.stale.sweep(),
      contracts: () => this.alerts.sweep(),
      backup: () => this.backups.sweep(),
    } satisfies Record<SweepParamDto["name"], () => Promise<object>>;
    return { name: params.name, result: { ...(await run[params.name]()) } };
  }

  @Get("subscriptions")
  @ApiOperation({ summary: "The devices this account receives push on, newest first" })
  @ApiOkResponse({ type: [SubscriptionView] })
  subscriptions(@CurrentViewer() viewer: Viewer): Promise<KeptSubscription[]> {
    return this.notices.subscriptions(viewer.userId);
  }

  @Delete("subscriptions/:id")
  @ApiOperation({ summary: "Stop push to one of this account's devices" })
  @ApiParam({ name: "id", description: "Subscription id (UUID)", example: "4bb7fb6b-6b0f-42af-9b7a-2f2a5c7a23f7" })
  @ApiOkResponse({ type: DoneView })
  @ApiNotFoundResponse({ type: ErrorBody, description: "NOTICE_NOT_FOUND, also for another account's device" })
  async dropSubscription(@CurrentViewer() viewer: Viewer, @Param("id") id: string): Promise<{ done: true }> {
    await this.notices.dropSubscription(viewer.userId, id);
    return { done: true };
  }

  @Get("items/:key")
  @ApiOperation({ summary: "One piece of shared work: state, result, who is on it, and for the group whom it reached" })
  @ApiParam(ITEM_KEY)
  @ApiOkResponse({ type: NoticeItemDetailView })
  @ApiNotFoundResponse({ type: ErrorBody, description: "NOTICE_NOT_FOUND for anybody outside the group, the person and ADMIN" })
  item(@CurrentViewer() viewer: Viewer, @Param("key") key: string): Promise<ItemDetail> {
    return this.items.detail(viewer, key);
  }

  @Post("items/:key/claim")
  @ApiOperation({ summary: "Say \"I am on it\" for the group; letters and disputes only, and it lapses" })
  @ApiParam(ITEM_KEY)
  @ApiCreatedResponse({ type: NoticeItemDetailView })
  @ApiNotFoundResponse({ type: ErrorBody, description: "NOTICE_NOT_FOUND outside the group or on a queue without claims" })
  @ApiConflictResponse({ type: ErrorBody, description: "NOTICE_ITEM_CLOSED" })
  claim(@CurrentViewer() viewer: Viewer, @Param("key") key: string): Promise<ItemDetail> {
    return this.items.claim(viewer, key);
  }

  @Delete("items/:key/claim")
  @ApiOperation({ summary: "Let go of one's own claim; somebody else's stays" })
  @ApiParam(ITEM_KEY)
  @ApiOkResponse({ type: NoticeItemDetailView })
  @ApiNotFoundResponse({ type: ErrorBody, description: "NOTICE_NOT_FOUND outside the group or on a queue without claims" })
  unclaim(@CurrentViewer() viewer: Viewer, @Param("key") key: string): Promise<ItemDetail> {
    return this.items.unclaim(viewer, key);
  }

  @Post("items/:key/resolve")
  @ApiOperation({ summary: "Close work by hand, with a note; only kinds no business decision closes" })
  @ApiParam(ITEM_KEY)
  @ApiCreatedResponse({ type: NoticeItemDetailView })
  @ApiNotFoundResponse({ type: ErrorBody, description: "NOTICE_NOT_FOUND outside the group" })
  @ApiConflictResponse({ type: ErrorBody, description: "NOTICE_ITEM_NOT_RESOLVABLE: its own queue decides it" })
  resolve(@CurrentViewer() viewer: Viewer, @Param("key") key: string, @Body() _body: ResolveItemDto): Promise<ItemDetail> {
    return this.items.resolve(viewer, key);
  }

  @Get("preferences")
  @ApiOperation({ summary: "The kinds this account receives, on the two channels somebody delivers, defaults filled in" })
  @ApiOkResponse({ type: [OfferedPreferenceView] })
  preferences(@CurrentViewer() viewer: Viewer): Promise<PreferenceRow[]> {
    return this.notices.preferences(viewer);
  }

  @Post("preferences")
  @ApiOperation({ summary: "Turn one kind on one channel on or off; a work item's in-app switch stays on" })
  @ApiCreatedResponse({ type: SavedPreferenceView })
  @ApiErrors(HttpStatus.NOT_FOUND, HttpStatus.CONFLICT)
  setPreference(
    @CurrentViewer() viewer: Viewer,
    @Body() body: SetPreferenceDto,
  ): Promise<NotificationPreference> {
    return this.notices.setPreference(viewer, body);
  }

  @Post("subscribe")
  @ApiOperation({ summary: "Register this device for push; an endpoint another account holds stays with it" })
  @ApiCreatedResponse({ type: SubscriptionView })
  @ApiBadRequestResponse({ type: ErrorBody, description: "PUSH_ENDPOINT_REFUSED: not a known push service" })
  @ApiConflictResponse({ type: ErrorBody, description: "PUSH_ENDPOINT_TAKEN" })
  subscribe(@CurrentViewer() viewer: Viewer, @Body() body: SubscribeDto): Promise<KeptSubscription> {
    return this.notices.subscribe(viewer.userId, body);
  }

  @Delete("subscribe")
  @ApiOperation({ summary: "Drop this device, leaving the person's others alone" })
  @ApiOkResponse({ type: DoneView })
  @ApiBadRequestResponse({ type: ErrorBody, description: "PUSH_ENDPOINT_REQUIRED" })
  async unsubscribe(
    @CurrentViewer() viewer: Viewer,
    @Query() query: UnsubscribeQueryDto,
  ): Promise<{ done: true }> {
    await this.notices.unsubscribe(viewer, query.endpoint);
    return { done: true };
  }

  @Get(":id")
  @ApiOperation({ summary: "One of the reader's notices, for the page a push or a letter points at" })
  @ApiParam(NOTICE_ID)
  @ApiOkResponse({ type: NoticeView })
  @ApiNotFoundResponse({ type: ErrorBody, description: "NOTICE_NOT_FOUND, also for another account's notice" })
  one(@CurrentViewer() viewer: Viewer, @Param("id") id: string): Promise<NoticeRow> {
    return this.notices.one(viewer, id);
  }

  private mark(viewer: Viewer, action: MarkAction, body: MarkNoticesDto): Promise<NoticeCounts & { changed: number }> {
    return this.notices.mark(viewer, action, body);
  }
}
