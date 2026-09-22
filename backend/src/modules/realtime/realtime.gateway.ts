import { Logger } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
  WebSocketServer,
} from "@nestjs/websockets";
import { Server, Socket } from "socket.io";

import { ScopeService } from "../../common/scope/scope.service.js";
import type { Viewer } from "../../common/scope/viewer.js";
import type { Env } from "../../config/env.schema.js";
import type { AccessClaims } from "../auth/auth.types.js";

/** What the dashboard can be told about, each carrying one kiosk's news. */
export const FEED = {
  attendance: "attendance",
  event: "event",
  device: "device",
} as const;

export type FeedName = (typeof FEED)[keyof typeof FEED];

// KEHOACH 9.15 puts the fleet behind one role, so its news goes no wider.
const FLEET_ROLES: ReadonlySet<string> = new Set(["ADMIN"]);
const MS_PER_SECOND = 1000;

/** Who is listening, and which employees they are allowed to hear about.
 *  A null reach is everyone, the same answer visibleEmployeeIds gives.
 */
interface Watcher {
  viewer: Viewer;
  reach: Set<number> | null;
  goodUntilMs: number;
}

@WebSocketGateway({ namespace: "/feed", cors: { credentials: true } })
export class RealtimeGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly log = new Logger(RealtimeGateway.name);
  private readonly watchers = new Map<string, Watcher>();

  @WebSocketServer()
  private server!: Server;

  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly jwt: JwtService,
    private readonly scope: ScopeService,
  ) {}

  async handleConnection(client: Socket): Promise<void> {
    const ticket = this.readTicket(client);
    if (!ticket) {
      client.disconnect(true);
      return;
    }
    const visible = await this.scope.visibleEmployeeIds(ticket.viewer);
    this.watchers.set(client.id, {
      viewer: ticket.viewer,
      reach: visible === null ? null : new Set(visible),
      goodUntilMs: ticket.goodUntilMs,
    });
    this.log.log(`${ticket.viewer.role} opened the feed, ${this.watchers.size} watching`);
  }

  handleDisconnect(client: Socket): void {
    this.watchers.delete(client.id);
  }

  private readTicket(client: Socket): { viewer: Viewer; goodUntilMs: number } | null {
    const token = client.handshake.auth?.token;
    if (typeof token !== "string" || token === "") {
      return null;
    }
    try {
      const claims = this.jwt.verify<AccessClaims & { exp?: number }>(token, {
        secret: this.config.get("JWT_ACCESS_SECRET", { infer: true }),
      });
      return {
        viewer: { userId: claims.sub, role: claims.role, employeeId: claims.employeeId ?? null },
        goodUntilMs: (claims.exp ?? 0) * MS_PER_SECOND,
      };
    } catch {
      return null;
    }
  }

  /** Tell the dashboards allowed to hear it, one socket at a time: a namespace
   *  emit would carry one person's punch to everybody watching (KEHOACH 9.4).
   */
  publish(feed: FeedName, body: unknown, about?: number | null): void {
    const now = Date.now();
    for (const [id, watcher] of this.watchers) {
      // A ticket REST would refuse buys no more here: leaving closes sessions
      // (KEHOACH 9.23) and an open socket must not outlive that.
      if (watcher.goodUntilMs <= now) {
        this.server?.to(id).disconnectSockets(true);
        this.watchers.delete(id);
        continue;
      }
      if (this.mayHear(watcher, feed, about)) {
        this.server?.to(id).emit(feed, body);
      }
    }
  }

  private mayHear(watcher: Watcher, feed: FeedName, about?: number | null): boolean {
    if (feed !== FEED.attendance) {
      return FLEET_ROLES.has(watcher.viewer.role);
    }
    if (watcher.reach === null) {
      return true;
    }
    return about !== undefined && about !== null && watcher.reach.has(about);
  }

  get watching(): number {
    return this.watchers.size;
  }
}
