import { Logger, type INestApplicationContext } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import { OnEvent } from "@nestjs/event-emitter";
import { IoAdapter } from "@nestjs/platform-socket.io";
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
  WebSocketServer,
} from "@nestjs/websockets";
import { Server, Socket, type ServerOptions } from "socket.io";

import { ScopeService } from "../../common/scope/scope.service.js";
import type { Viewer } from "../../common/scope/viewer.js";
import type { Env } from "../../config/env.schema.js";
import { AuthService } from "../auth/auth.service.js";
import { SESSIONS_CUT, type AccessClaims, type SessionsCut } from "../auth/auth.types.js";

/** What the dashboard can be told about; KEHOACH 9.4 names who hears each. */
export const FEED = {
  attendance: "attendance",
  event: "event",
  device: "device",
  change: "change",
  notice: "notice",
} as const;

export type FeedName = (typeof FEED)[keyof typeof FEED];

export type About = number | readonly number[] | null;

// KEHOACH 9.15 puts the fleet behind one role, so its news goes no wider.
const FLEET_ROLES: ReadonlySet<string> = new Set(["ADMIN"]);
const FLEET_FEEDS: ReadonlySet<FeedName> = new Set([FEED.device, FEED.event]);
const MS_PER_SECOND = 1000;

/** Who is listening, and which employees they are allowed to hear about.
 *  A null reach is everyone, the same answer visibleEmployeeIds gives.
 */
interface Watcher {
  viewer: Viewer;
  reach: Set<number> | null;
  goodUntilMs: number;
}

interface Ticket {
  claims: AccessClaims & { iat?: number };
  viewer: Viewer;
  goodUntilMs: number;
}

/** Socket.io takes its CORS list when the server is made, so the one REST answers reaches it here. */
export class FeedAdapter extends IoAdapter {
  constructor(
    app: INestApplicationContext,
    private readonly origins: string[],
  ) {
    super(app);
  }

  override createIOServer(port: number, options?: ServerOptions): Server {
    const cors = { origin: this.origins, credentials: true };
    return super.createIOServer(port, { ...options, cors } as ServerOptions);
  }
}

@WebSocketGateway({ namespace: "/feed" })
export class RealtimeGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly log = new Logger(RealtimeGateway.name);
  private readonly watchers = new Map<string, Watcher>();

  @WebSocketServer()
  private server!: Server;

  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly jwt: JwtService,
    private readonly scope: ScopeService,
    private readonly auth: AuthService,
  ) {}

  async handleConnection(client: Socket): Promise<void> {
    const ticket = this.readTicket(client);
    // The same cutoff REST checks, so a locked or demoted login opens no socket (KEHOACH 9.23).
    if (!ticket || (await this.auth.accessCut(ticket.claims, ticket.claims.iat ?? 0))) {
      client.disconnect(true);
      return;
    }
    const visible = await this.scope.visibleEmployeeIds(ticket.viewer);
    // A socket gone during the awaits already ran handleDisconnect, so nothing would delete it.
    if (!client.connected) {
      return;
    }
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

  private readTicket(client: Socket): Ticket | null {
    const token = client.handshake.auth?.token;
    if (typeof token !== "string" || token === "") {
      return null;
    }
    try {
      const claims = this.jwt.verify<AccessClaims & { iat?: number; exp?: number }>(token, {
        secret: this.config.get("JWT_ACCESS_SECRET", { infer: true }),
      });
      return {
        claims,
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
  publish(feed: FeedName, body: unknown, about?: About): void {
    this.deliver(feed, body, (watcher) => this.mayHear(watcher, feed, about));
  }

  /** Tell every open socket; only for tables every login reads (KEHOACH 9.4). */
  announce(feed: FeedName, body: unknown): void {
    this.deliver(feed, body, () => true);
  }

  /** Close the sockets these logins hold the moment their sessions close (KEHOACH 9.23). */
  @OnEvent(SESSIONS_CUT)
  drop(cut: SessionsCut): void {
    for (const [id, watcher] of this.watchers) {
      if (cut.userIds.includes(watcher.viewer.userId)) {
        this.server?.to(id).disconnectSockets(true);
        this.watchers.delete(id);
      }
    }
  }

  /** Tell the sockets one login holds open, on whichever of its devices. */
  tell(userId: string, feed: FeedName, body: unknown): void {
    this.deliver(feed, body, (watcher) => watcher.viewer.userId === userId);
  }

  private deliver(feed: FeedName, body: unknown, hears: (watcher: Watcher) => boolean): void {
    const now = Date.now();
    for (const [id, watcher] of this.watchers) {
      // A ticket REST would refuse buys no more here: leaving closes sessions
      // (KEHOACH 9.23) and an open socket must not outlive that.
      if (watcher.goodUntilMs <= now) {
        this.server?.to(id).disconnectSockets(true);
        this.watchers.delete(id);
        continue;
      }
      if (hears(watcher)) {
        this.server?.to(id).emit(feed, body);
      }
    }
  }

  private mayHear(watcher: Watcher, feed: FeedName, about?: About): boolean {
    if (FLEET_FEEDS.has(feed)) {
      return FLEET_ROLES.has(watcher.viewer.role);
    }
    const reach = watcher.reach;
    if (reach === null) {
      return true;
    }
    if (about === undefined || about === null) {
      return false;
    }
    const owners = typeof about === "number" ? [about] : about;
    return owners.some((owner) => reach.has(owner));
  }

  get watching(): number {
    return this.watchers.size;
  }
}
