import { randomUUID } from "node:crypto";

import { ConflictException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import type { Release } from "@prisma/client";

import type { OtaManifest } from "../../common/generated/ota_manifest.js";
import { PrismaService } from "../../database/prisma.service.js";
import { MqttService } from "../mqtt/mqtt.service.js";
import type { CreateReleaseDto } from "./dto/release.dto.js";

const UNIQUE_VIOLATION = "P2002";

@Injectable()
export class ModelsService {
  private readonly log = new Logger(ModelsService.name);

  constructor(
    private readonly db: PrismaService,
    private readonly mqtt: MqttService,
  ) {}

  list(): Promise<Release[]> {
    return this.db.release.findMany({ orderBy: { createdAt: "desc" } });
  }

  async create(body: CreateReleaseDto): Promise<Release> {
    try {
      return await this.db.release.create({
        data: { ...body, releaseId: randomUUID() },
      });
    } catch (error) {
      if (isCode(error, UNIQUE_VIOLATION)) {
        throw new ConflictException(`${body.target} ${body.version} already exists`);
      }
      throw error;
    }
  }

  /**
   * Offer a release to one kiosk.
   *
   * The kiosk re-checks everything here on its own, so this is an offer and
   * not an instruction: it refuses a bad digest or an image past its slot.
   */
  async offer(releaseId: string, deviceId: string): Promise<OtaManifest> {
    const release = await this.db.release.findUnique({ where: { releaseId } });
    if (!release) {
      throw new NotFoundException(`no release ${releaseId}`);
    }
    const device = await this.db.device.findUnique({ where: { id: deviceId } });
    if (!device) {
      throw new NotFoundException(`no device ${deviceId}`);
    }
    const manifest: OtaManifest = {
      releaseId: release.releaseId,
      target: release.target as OtaManifest["target"],
      version: release.version,
      url: release.url,
      sha256: release.sha256,
      sizeBytes: release.sizeBytes,
      ...(release.minFwVersion ? { minFwVersion: release.minFwVersion } : {}),
      ...(release.runId ? { runId: release.runId } : {}),
    };
    await this.mqtt.publishDown("ota", deviceId, manifest);
    await this.db.release.update({
      where: { releaseId },
      data: { rolloutState: "ROLLING" },
    });
    this.log.log(`offered ${release.target} ${release.version} to ${deviceId}`);
    return manifest;
  }
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
