import { Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
  WebSocketServer,
} from "@nestjs/websockets";
import { Server, Socket } from "socket.io";

import type { Env } from "../../config/env.schema.js";

/** What the dashboard can be told about, each carrying one kiosk's news. */
export const FEED = {
  attendance: "attendance",
  event: "event",
  device: "device",
} as const;

export type FeedName = (typeof FEED)[keyof typeof FEED];

@WebSocketGateway({ namespace: "/feed", cors: { credentials: true } })
export class RealtimeGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly log = new Logger(RealtimeGateway.name);
  private watchers = 0;

  @WebSocketServer()
  private server!: Server;

  constructor(private readonly config: ConfigService<Env, true>) {}

  handleConnection(client: Socket): void {
    this.watchers += 1;
    this.log.log(`a dashboard opened the feed, ${this.watchers} watching`);
    void client;
  }

  handleDisconnect(): void {
    this.watchers -= 1;
  }

  /** Tell every open dashboard. A feed nobody is watching costs one no-op. */
  publish(feed: FeedName, body: unknown): void {
    this.server?.emit(feed, body);
  }

  get watching(): number {
    return this.watchers;
  }
}
