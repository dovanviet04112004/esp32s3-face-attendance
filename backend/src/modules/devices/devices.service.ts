import { Injectable, Logger } from "@nestjs/common";

import { PrismaService } from "../../database/prisma.service.js";

@Injectable()
export class DevicesService {
  private readonly log = new Logger(DevicesService.name);

  constructor(private readonly db: PrismaService) {}

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
