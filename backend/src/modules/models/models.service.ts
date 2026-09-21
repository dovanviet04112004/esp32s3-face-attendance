import { createHash, randomUUID } from "node:crypto";

import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Release } from "@prisma/client";

import type { OtaManifest } from "../../common/generated/ota_manifest.js";
import type { Env } from "../../config/env.schema.js";
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
    private readonly config: ConfigService<Env, true>,
  ) {}

  /** Reads the image once and reports what it is. A digest typed by hand is a
   *  digest that can disagree with the file, and the kiosk finds out last.
   */
  private async measure(url: string): Promise<{ sha256: string; sizeBytes: number }> {
    const ceiling = this.config.get("OTA_MAX_BYTES", { infer: true });
    const stop = AbortSignal.timeout(this.config.get("OTA_FETCH_TIMEOUT_MS", { infer: true }));
    let answer: Response;
    try {
      answer = await fetch(url, { signal: stop, redirect: "follow" });
    } catch {
      throw new BadRequestException("RELEASE_UNREACHABLE");
    }
    if (!answer.ok || !answer.body) {
      throw new BadRequestException("RELEASE_UNREACHABLE");
    }
    const digest = createHash("sha256");
    let sizeBytes = 0;
    for await (const chunk of answer.body as AsyncIterable<Uint8Array>) {
      sizeBytes += chunk.byteLength;
      if (sizeBytes > ceiling) {
        throw new BadRequestException("RELEASE_TOO_BIG");
      }
      digest.update(chunk);
    }
    if (sizeBytes === 0) {
      throw new BadRequestException("RELEASE_EMPTY");
    }
    return { sha256: digest.digest("hex"), sizeBytes };
  }

  list(): Promise<Release[]> {
    return this.db.release.findMany({ orderBy: { createdAt: "desc" } });
  }

  async create(body: CreateReleaseDto): Promise<Release> {
    const measured = await this.measure(body.url);
    this.log.log(
      `${body.target} ${body.version} measured ${measured.sizeBytes} bytes, ${measured.sha256}`,
    );
    try {
      return await this.db.release.create({
        data: { ...body, ...measured, releaseId: randomUUID() },
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
