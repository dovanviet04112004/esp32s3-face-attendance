import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Asset, AssetState, AssetTransfer, Prisma } from "@prisma/client";

import type { Page } from "../../common/dto/pagination.dto.js";
import { COUNT_CEILING, countedTo } from "../../common/dto/cursor.dto.js";
import { toExcelCsv } from "../../common/csv.js";

import { ScopeService } from "../../common/scope/scope.service.js";
import type { Viewer } from "../../common/scope/viewer.js";
import type { Env } from "../../config/env.schema.js";
import { PrismaService } from "../../database/prisma.service.js";
import { AUDIT_ACTIONS, AUDIT_SUBJECTS } from "../audit/audit-actions.js";
import { AuditService } from "../audit/audit.service.js";
import { localDay } from "../timesheet/local-day.js";
import type {
  AssetFilterDto,
  CreateAssetDto,
  HandOverDto,
  ListAssetsDto,
  UpdateAssetDto,
} from "./dto/asset.dto.js";

const HOLDER = {
  select: { id: true, code: true, fullName: true, department: { select: { id: true, name: true } } },
} satisfies Prisma.EmployeeDefaultArgs;

const REGISTER_ROW = {
  holder: HOLDER,
  transfers: { where: { issued: true }, orderBy: { at: "desc" }, take: 1, select: { at: true } },
} satisfies Prisma.AssetInclude;

type RegisterRow = Prisma.AssetGetPayload<{ include: typeof REGISTER_ROW }>;

export type AssetWithHolder = Prisma.AssetGetPayload<{ include: { holder: typeof HOLDER } }>;

/** A register row, with when its current holder took it. */
export type AssetRow = AssetWithHolder & { issuedAt: Date | null };

export interface AssetCounts {
  states: Record<AssetState, number>;
  kinds: string[];
}

const UNIQUE_VIOLATION = "P2002";
const FOREIGN_KEY_VIOLATION = "P2003";
const NOT_FOUND = "P2025";
// A register this long is a data problem, not a spreadsheet; the export says so by stopping.
const kExportMax = 50_000;
const EXPORT_HEADER = ["code", "name", "kind", "serialNo", "state", "holderCode", "holderName", "department", "issuedAt"];

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function asRow(row: RegisterRow): AssetRow {
  const { transfers, ...asset } = row;
  return { ...asset, issuedAt: asset.state === "ISSUED" ? (transfers[0]?.at ?? null) : null };
}

function filterOf(query: AssetFilterDto, withState = true): Prisma.AssetWhereInput {
  const needle = query.search?.trim() ? { contains: query.search.trim(), mode: "insensitive" as const } : null;
  return {
    ...(withState && query.state ? { state: query.state } : {}),
    ...(query.kind ? { kind: query.kind } : {}),
    ...(query.holderId ? { holderId: query.holderId } : {}),
    ...(needle
      ? {
          OR: [
            { code: needle },
            { name: needle },
            { serialNo: needle },
            { holder: { fullName: needle } },
            { holder: { code: needle } },
          ],
        }
      : {}),
  };
}

@Injectable()
export class AssetsService {
  constructor(
    private readonly db: PrismaService,
    private readonly scope: ScopeService,
    private readonly audit: AuditService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async list(query: ListAssetsDto): Promise<Page<AssetRow>> {
    const where = filterOf(query);
    // Code is unique, so the cursor resumes on it with no tiebreak (KEHOACH 9.9 rule 3).
    const [rows, found] = await Promise.all([
      this.db.asset.findMany({
        where: { AND: [where, query.cursor ? { code: { gt: query.cursor } } : {}] },
        include: REGISTER_ROW,
        orderBy: { code: "asc" },
        take: query.take,
        ...(query.cursor ? {} : { skip: query.skip }),
      }),
      this.db.asset.count({ where, take: COUNT_CEILING + 1 }),
    ]);
    const last = rows[rows.length - 1];
    return { ...countedTo(found), rows: rows.map(asRow), next: rows.length === query.take && last ? last.code : null };
  }

  /** The register under the list's own filters, as a file Excel opens. */
  async exportCsv(query: AssetFilterDto): Promise<string> {
    const rows = await this.db.asset.findMany({
      where: filterOf(query),
      include: REGISTER_ROW,
      orderBy: { code: "asc" },
      take: kExportMax,
    });
    const zone = this.config.get("APP_TIMEZONE", { infer: true });
    return toExcelCsv(
      EXPORT_HEADER,
      rows.map(asRow).map((one) => [
        one.code,
        one.name,
        one.kind,
        one.serialNo ?? "",
        one.state,
        one.holder?.code ?? "",
        one.holder?.fullName ?? "",
        one.holder?.department?.name ?? "",
        one.issuedAt ? localDay(one.issuedAt, zone) : "",
      ]),
    );
  }

  /** How many assets stand in each state under the other filters, and the kinds on the register. */
  async counts(query: AssetFilterDto): Promise<AssetCounts> {
    const [grouped, kinds] = await Promise.all([
      this.db.asset.groupBy({ by: ["state"], where: filterOf(query, false), _count: { _all: true } }),
      this.db.asset.findMany({ distinct: ["kind"], select: { kind: true }, orderBy: { kind: "asc" } }),
    ]);
    const states: Record<AssetState, number> = { IN_STOCK: 0, ISSUED: 0, RETURNED: 0, RETIRED: 0, LOST: 0 };
    for (const row of grouped) {
      states[row.state] = row._count._all;
    }
    return { states, kinds: kinds.map((row) => row.kind) };
  }

  async create(viewer: Viewer, body: CreateAssetDto): Promise<Asset> {
    const made = await this.db.asset
      .create({ data: { code: body.code, name: body.name, kind: body.kind, serialNo: body.serialNo ?? null } })
      .catch((error: unknown) => {
        throw isCode(error, UNIQUE_VIOLATION) ? new ConflictException("ASSET_CODE_TAKEN") : error;
      });
    await this.audit.record({
      actorId: viewer.userId,
      action: AUDIT_ACTIONS.ASSET_CREATE,
      subject: AUDIT_SUBJECTS.ASSET,
      subjectId: made.code,
      meta: { kind: made.kind },
    });
    return made;
  }

  /** Correct the description of an asset; who holds it moves only through a hand-over. */
  async update(viewer: Viewer, id: string, body: UpdateAssetDto): Promise<Asset> {
    const held = await this.require(id);
    const saved = await this.db.asset.update({ where: { id }, data: body }).catch((error: unknown) => {
      throw isCode(error, NOT_FOUND) ? new NotFoundException("ASSET_NOT_FOUND") : error;
    });
    await this.audit.record({
      actorId: viewer.userId,
      action: AUDIT_ACTIONS.ASSET_UPDATE,
      subject: AUDIT_SUBJECTS.ASSET,
      subjectId: held.code,
      meta: { fields: Object.keys(body) },
    });
    return saved;
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
    }).catch((error: unknown) => {
      throw isCode(error, FOREIGN_KEY_VIOLATION) ? new NotFoundException("EMPLOYEE_NOT_FOUND") : error;
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
