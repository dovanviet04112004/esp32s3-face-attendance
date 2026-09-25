import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import type { Asset, AssetState, AssetTransfer } from "@prisma/client";

import type { Page } from "../../common/dto/pagination.dto.js";
import { COUNT_CEILING, countedTo } from "../../common/dto/cursor.dto.js";

import { ScopeService } from "../../common/scope/scope.service.js";
import type { Viewer } from "../../common/scope/viewer.js";
import { PrismaService } from "../../database/prisma.service.js";
import { AUDIT_ACTIONS, AUDIT_SUBJECTS } from "../audit/audit-actions.js";
import { AuditService } from "../audit/audit.service.js";
import type { CreateAssetDto, HandOverDto, ListAssetsDto } from "./dto/asset.dto.js";

export type AssetWithHolder = Asset & {
  holder: { id: number; code: string; fullName: string } | null;
};

export interface AssetCounts {
  states: Record<AssetState, number>;
  kinds: string[];
}

const HOLDER = { select: { id: true, code: true, fullName: true } } as const;

@Injectable()
export class AssetsService {
  constructor(
    private readonly db: PrismaService,
    private readonly scope: ScopeService,
    private readonly audit: AuditService,
  ) {}

  async list(query: ListAssetsDto): Promise<Page<AssetWithHolder>> {
    const needle = query.search ? { contains: query.search, mode: "insensitive" as const } : null;
    const where = {
      ...(query.state ? { state: query.state } : {}),
      ...(query.kind ? { kind: query.kind } : {}),
      ...(query.holderId ? { holderId: query.holderId } : {}),
      ...(needle
        ? { OR: [{ code: needle }, { name: needle }, { serialNo: needle }, { holder: { fullName: needle } }] }
        : {}),
    };
    // Code is unique, so the cursor resumes on it with no tiebreak (KEHOACH 9.9 rule 3).
    const [rows, found] = await Promise.all([
      this.db.asset.findMany({
        where,
        include: { holder: HOLDER },
        orderBy: { code: "asc" },
        take: query.take,
        ...(query.cursor ? { cursor: { code: query.cursor }, skip: 1 } : { skip: query.skip }),
      }),
      this.db.asset.count({ where, take: COUNT_CEILING + 1 }),
    ]);
    const last = rows[rows.length - 1];
    return { ...countedTo(found), rows, next: rows.length === query.take && last ? last.code : null };
  }

  /** How many assets stand in each state, and the kinds the register holds, for its filters. */
  async counts(): Promise<AssetCounts> {
    const [grouped, kinds] = await Promise.all([
      this.db.asset.groupBy({ by: ["state"], _count: { _all: true } }),
      this.db.asset.findMany({ distinct: ["kind"], select: { kind: true }, orderBy: { kind: "asc" } }),
    ]);
    const states: Record<AssetState, number> = { IN_STOCK: 0, ISSUED: 0, RETURNED: 0, RETIRED: 0, LOST: 0 };
    for (const row of grouped) {
      states[row.state] = row._count._all;
    }
    return { states, kinds: kinds.map((row) => row.kind) };
  }

  create(body: CreateAssetDto): Promise<Asset> {
    return this.db.asset.create({
      data: { code: body.code, name: body.name, kind: body.kind, serialNo: body.serialNo ?? null },
    });
  }

  /** Every hand-over this asset has been through, newest first. */
  async history(assetId: string): Promise<AssetTransfer[]> {
    await this.require(assetId);
    return this.db.assetTransfer.findMany({
      where: { assetId },
      include: { employee: HOLDER },
      orderBy: { at: "desc" },
    });
  }

  /** What one person is still holding, which is what offboarding reads. */
  async heldBy(viewer: Viewer, employeeId: number): Promise<AssetWithHolder[]> {
    const visible = await this.scope.visibleEmployeeIds(viewer);
    if (visible !== null && !visible.includes(employeeId)) {
      throw new NotFoundException("EMPLOYEE_NOT_FOUND");
    }
    return this.db.asset.findMany({
      where: { holderId: employeeId, state: "ISSUED" },
      include: { holder: HOLDER },
      orderBy: { code: "asc" },
    });
  }

  /**
   * The one write. The row is the history and the field on the asset is a
   * summary of it, so both move together or neither does (KEHOACH 9.3).
   */
  async handOver(viewer: Viewer, assetId: string, body: HandOverDto): Promise<AssetWithHolder> {
    const asset = await this.require(assetId);
    if (body.issued && asset.state === "ISSUED") {
      throw new ConflictException("ASSET_ALREADY_ISSUED");
    }
    if (!body.issued && asset.state !== "ISSUED") {
      throw new ConflictException("ASSET_NOT_ISSUED");
    }
    if (!body.issued && asset.holderId !== body.employeeId) {
      throw new ConflictException("ASSET_HELD_BY_SOMEBODY_ELSE");
    }
    const moved = await this.db.$transaction(async (tx) => {
      // The state is claimed by the update itself, so two people handing the
      // same laptop out at once cannot both read it as free.
      const claimed = await tx.asset.updateMany({
        where: {
          id: assetId,
          ...(body.issued
            ? { state: { not: "ISSUED" } }
            : { state: "ISSUED", holderId: body.employeeId }),
        },
        data: {
          state: body.issued ? "ISSUED" : "RETURNED",
          holderId: body.issued ? body.employeeId : null,
        },
      });
      if (claimed.count === 0) {
        throw new ConflictException(body.issued ? "ASSET_ALREADY_ISSUED" : "ASSET_NOT_ISSUED");
      }
      await tx.assetTransfer.create({
        data: {
          assetId,
          employeeId: body.employeeId,
          issued: body.issued,
          condition: body.condition ?? "GOOD",
          note: body.note ?? null,
          byUserId: viewer.userId,
        },
      });
      return tx.asset.findUniqueOrThrow({ where: { id: assetId }, include: { holder: HOLDER } });
    });
    await this.audit.record({
      actorId: viewer.userId,
      action: body.issued ? AUDIT_ACTIONS.ASSET_ISSUE : AUDIT_ACTIONS.ASSET_RETURN,
      subject: AUDIT_SUBJECTS.ASSET,
      subjectId: asset.code,
      meta: { employeeId: body.employeeId, condition: body.condition ?? "GOOD" },
    });
    return moved;
  }

  private async require(id: string): Promise<Asset> {
    const found = await this.db.asset.findUnique({ where: { id } });
    if (!found) {
      throw new NotFoundException("ASSET_NOT_FOUND");
    }
    return found;
  }
}
