import { createHash, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

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

// Where a server-side fetch must never land: compose peers, loopback, cloud metadata (KEHOACH 7.2).
const INTERNAL = new BlockList();
for (const [net, bits] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.168.0.0", 16]] as const) {
  INTERNAL.addSubnet(net, bits, "ipv4");
}
for (const [net, bits] of [["::", 127], ["fc00::", 7], ["fe80::", 10], ["::ffff:0:0", 96]] as const) {
  INTERNAL.addSubnet(net, bits, "ipv6");
}

async function refuseInternal(url: string): Promise<void> {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
  const family = isIP(host);
  const found = family ? [{ address: host, family }] : await lookup(host, { all: true }).catch(() => []);
  if (found.length === 0) {
    throw new BadRequestException("RELEASE_UNREACHABLE");
  }
  if (found.some((one) => INTERNAL.check(one.address, one.family === 6 ? "ipv6" : "ipv4"))) {
    throw new BadRequestException("RELEASE_URL_INTERNAL");
  }
}

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
    await refuseInternal(url);
    let answer: Response;
    try {
      answer = await fetch(url, { signal: stop, redirect: "manual" });
    } catch {
      throw new BadRequestException("RELEASE_UNREACHABLE");
    }
    // A redirect would take the fetch past the address check above.
    if (answer.status >= 300 && answer.status < 400) {
      throw new BadRequestException("RELEASE_REDIRECTED");
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
        throw new ConflictException("RELEASE_ALREADY_EXISTS");
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
      throw new NotFoundException("RELEASE_NOT_FOUND");
    }
    const device = await this.db.device.findUnique({ where: { id: deviceId } });
    if (!device) {
      throw new NotFoundException("DEVICE_NOT_FOUND");
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
