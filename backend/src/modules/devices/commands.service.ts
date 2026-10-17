import { randomUUID } from "node:crypto";

import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { OnEvent } from "@nestjs/event-emitter";
import type { CommandState, Prisma } from "@prisma/client";

import { deviceCmdSchema, type DeviceCommand } from "../../common/generated/device_cmd.js";
import type { DeviceEvent } from "../../common/generated/device_event.js";
import type { Viewer } from "../../common/scope/viewer.js";
import type { Env } from "../../config/env.schema.js";
import { PrismaService } from "../../database/prisma.service.js";
import { AUDIT_ACTIONS, AUDIT_SUBJECTS } from "../audit/audit-actions.js";
import { AuditService } from "../audit/audit.service.js";
import { KIOSK_EVENT, type KioskMessage } from "../mqtt/mqtt.events.js";
import { MqttService } from "../mqtt/mqtt.service.js";

/** What a person asks a kiosk to do; the server fills in the command's id, time and deadline. */
export type CommandAsk = Pick<DeviceCommand, "action" | "openMs" | "activeSlot" | "config">;

/** A command as its kiosk page reads it, its state read at the moment of reading. */
export interface CommandView {
  cmdId: string;
  action: string;
  payload: Prisma.JsonValue;
  state: CommandState;
  resultNote: string | null;
  issuedBy: string | null;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const ANSWERED: Partial<Record<DeviceEvent["type"], CommandState>> = { COMMAND_DONE: "DONE", COMMAND_REJECTED: "REJECTED" };
const OPEN: CommandState[] = ["QUEUED", "SENT"];
// The generated config object drops a key it does not know, where a command has to refuse it.
const CONFIG_FIELDS: ReadonlySet<string> = new Set(Object.keys(deviceCmdSchema.shape.config.unwrap().shape));
const kRecentShown = 20;

function complete(ask: CommandAsk): boolean {
  if (ask.config && Object.keys(ask.config).some((key) => !CONFIG_FIELDS.has(key))) {
    return false;
  }
  if (ask.action === "SET_CONFIG") {
    return ask.config !== undefined && Object.keys(ask.config).length > 0;
  }
  return ask.action !== "SET_ACTIVE_SLOT" || ask.activeSlot !== undefined;
}

/** Commands to one kiosk at a time: written first, published, then closed by the kiosk's answer (KEHOACH 4.6). */
@Injectable()
export class CommandsService {
  private readonly log = new Logger(CommandsService.name);

  constructor(
    private readonly db: PrismaService,
    private readonly mqtt: MqttService,
    private readonly audit: AuditService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /** Write the command, then put it on down/cmd; an approved, online kiosk only.
   *  @ctx request | ADMIN | audited
   */
  async send(viewer: Viewer, deviceId: string, ask: CommandAsk): Promise<CommandView> {
    const device = await this.db.device.findUnique({ where: { id: deviceId }, select: { status: true, online: true } });
    if (!device) {
      throw new NotFoundException("DEVICE_NOT_FOUND");
    }
    if (device.status !== "APPROVED") {
      throw new ConflictException("DEVICE_NOT_APPROVED");
    }
    // QoS 1 to a clean session: an offline kiosk never hears it (KEHOACH 4.8).
    if (!device.online) {
      throw new ConflictException("DEVICE_OFFLINE");
    }
    if (!complete(ask)) {
      throw new BadRequestException("COMMAND_INVALID");
    }
    const ts = Date.now();
    const parsed = deviceCmdSchema.safeParse({
      ...ask,
      cmdId: randomUUID(),
      ts,
      expiresAt: ts + this.config.get("DEVICE_COMMAND_TTL_SECONDS", { infer: true }) * 1000,
      issuedBy: viewer.userId,
    });
    if (!parsed.success) {
      throw new BadRequestException("COMMAND_INVALID");
    }
    const command = parsed.data;
    const { cmdId, action } = command;
    const fields = Object.fromEntries(
      Object.entries({ openMs: command.openMs, activeSlot: command.activeSlot, config: command.config }).filter(
        ([, value]) => value !== undefined,
      ),
    ) as Prisma.InputJsonObject;
    await this.db.deviceCommand.create({
      data: {
        cmdId,
        deviceId,
        action,
        payload: fields,
        issuedById: viewer.userId,
        expiresAt: new Date(command.expiresAt as number),
      },
    });
    try {
      await this.mqtt.publishDown("cmd", deviceId, command);
    } catch (error) {
      await this.db.deviceCommand.update({
        where: { cmdId },
        data: { state: "REJECTED", resultNote: `not sent: ${(error as Error).message}` },
      });
      throw new ConflictException("COMMAND_NOT_SENT");
    }
    await this.db.deviceCommand.updateMany({ where: { cmdId, state: "QUEUED" }, data: { state: "SENT" } });
    await this.audit.record({
      actorId: viewer.userId,
      action: AUDIT_ACTIONS.DEVICE_COMMAND,
      subject: AUDIT_SUBJECTS.DEVICE,
      subjectId: deviceId,
      meta: { cmdId, action, ...fields },
    });
    this.log.log(`${deviceId} sent ${action} ${cmdId}`);
    const [view] = await this.read({ cmdId });
    return view;
  }

  /** The kiosk's newest commands, newest first. */
  async recent(deviceId: string): Promise<CommandView[]> {
    const device = await this.db.device.findUnique({ where: { id: deviceId }, select: { id: true } });
    if (!device) {
      throw new NotFoundException("DEVICE_NOT_FOUND");
    }
    return this.read({ deviceId });
  }

  /** Close a command on its kiosk's answer; a closed one stays as it is, so a redelivered answer writes nothing. */
  @OnEvent(KIOSK_EVENT.event)
  async onAnswer(message: KioskMessage<DeviceEvent>): Promise<void> {
    const state = ANSWERED[message.payload.type];
    const cmdId = message.payload.cmdId;
    if (!state || !cmdId) {
      return;
    }
    await this.db.deviceCommand
      .updateMany({
        where: { cmdId, deviceId: message.deviceId, state: { in: OPEN } },
        data: { state, resultNote: message.payload.message ?? null },
      })
      .catch((error: Error) => this.log.error(`${message.deviceId} answer to ${cmdId} not kept: ${error.message}`));
  }

  private async read(where: Prisma.DeviceCommandWhereInput): Promise<CommandView[]> {
    const rows = await this.db.deviceCommand.findMany({
      where,
      include: { issuedBy: { select: { email: true, employee: { select: { fullName: true } } } } },
      orderBy: { createdAt: "desc" },
      take: kRecentShown,
    });
    const now = Date.now();
    return rows.map((row) => ({
      cmdId: row.cmdId,
      action: row.action,
      payload: row.payload,
      // A deadline the kiosk never answered by is read as passed, with no sweep to write it (KEHOACH 4.6).
      state: OPEN.includes(row.state) && row.expiresAt !== null && row.expiresAt.getTime() < now ? "EXPIRED" : row.state,
      resultNote: row.resultNote,
      issuedBy: row.issuedBy ? (row.issuedBy.employee?.fullName ?? row.issuedBy.email) : null,
      expiresAt: row.expiresAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));
  }
}
