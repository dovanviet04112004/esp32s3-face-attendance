import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import type { Device, Prisma } from "@prisma/client";

import type { Page } from "../../common/dto/pagination.dto.js";
import { PrismaService } from "../../database/prisma.service.js";
import type { ApproveDeviceDto, ListDevicesDto, UpdateDeviceDto } from "./dto/device.dto.js";

interface HeartbeatFacts {
  fwVersion: string;
  modelVersion: string;
}

@Injectable()
export class DevicesService {
  private readonly log = new Logger(DevicesService.name);

  constructor(private readonly db: PrismaService) {}

  async list(query: ListDevicesDto): Promise<Page<Device>> {
    const where: Prisma.DeviceWhereInput = query.status ? { status: query.status } : {};
    const [rows, total] = await Promise.all([
      this.db.device.findMany({
        where,
        skip: query.skip,
        take: query.take,
        orderBy: [{ status: "asc" }, { id: "asc" }],
      }),
      this.db.device.count({ where }),
    ]);
    return { rows, total };
  }

  async get(id: string): Promise<Device> {
    const found = await this.db.device.findUnique({ where: { id } });
    if (!found) {
      throw new NotFoundException(`no device ${id}`);
    }
    return found;
  }

  async update(id: string, body: UpdateDeviceDto): Promise<Device> {
    await this.get(id);
    return this.db.device.update({ where: { id }, data: body });
  }

  /** Accept a machine: a person has matched the id on its screen (KEHOACH 7.3). */
  async approve(id: string, body: ApproveDeviceDto): Promise<Device> {
    await this.get(id);
    return this.db.device.update({
      where: { id },
      data: { ...body, status: "APPROVED", approvedAt: new Date() },
    });
  }

  /** Take a machine back; its credentials stop working and it re-registers. */
  async revoke(id: string): Promise<Device> {
    await this.get(id);
    return this.db.device.update({
      where: { id },
      data: { status: "REVOKED", tokenHash: null, online: false },
    });
  }

  /** Record what a heartbeat says about a kiosk, creating its row if needed. */
  async applyHeartbeat(deviceId: string, beat: HeartbeatFacts, at: Date): Promise<void> {
    await this.seen(deviceId, at);
    await this.db.device.update({
      where: { id: deviceId },
      data: {
        fwVersion: beat.fwVersion,
        modelVersion: beat.modelVersion,
        lastSeenAt: at,
        online: true,
      },
    });
  }

  /** Follow the retained status topic, which the broker writes on a last will. */
  async setOnline(deviceId: string, online: boolean, at: Date): Promise<void> {
    await this.seen(deviceId, at);
    await this.db.device.update({ where: { id: deviceId }, data: { online, lastSeenAt: at } });
  }

  /** Note that a device spoke; an unknown one lands at PENDING (KEHOACH 7.3). */
  async seen(deviceId: string, at: Date): Promise<void> {
    const known = await this.db.device.findUnique({ where: { id: deviceId } });
    if (!known) {
      this.log.warn(`${deviceId} spoke without a record, writing it as PENDING`);
    }
    await this.db.device.upsert({
      where: { id: deviceId },
      update: { lastSeenAt: at, online: true },
      create: { id: deviceId, lastSeenAt: at, online: true },
    });
  }
}
