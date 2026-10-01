import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "@prisma/client";

import type { Env } from "../config/env.schema.js";

const LIKE_WILDCARDS = String.raw`([\\%_])`;
const LIKE_AS_ITSELF = String.raw`\\\1`;
const kIdListMax = 16_000;

export type IdFilter = { in: number[] } | { notIn: number[] };

/** The one Prisma connection, opened with the app and closed with it. */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor(config: ConfigService<Env, true>) {
    super({
      adapter: new PrismaPg({
        connectionString: config.get("DATABASE_URL", { infer: true }),
      }),
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}

/** Text as the trigram indexes hold it; a query must spell this expression for one to serve it (KEHOACH 9.9 rule 4). */
export function folded(column: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`f_unaccent(lower(${column}))`;
}

function typed(term: string, fold: boolean): Prisma.Sql {
  const text = Prisma.sql`${term.normalize("NFC")}::text`;
  return Prisma.sql`regexp_replace(${fold ? folded(text) : text}, ${LIKE_WILDCARDS}::text, ${LIKE_AS_ITSELF}::text, 'g')`;
}

/** `column` holds the typed term anywhere, both folded, and a `%` or `_` typed matches only itself. */
export function foldedHas(column: Prisma.Sql, term: string): Prisma.Sql {
  return Prisma.sql`${folded(column)} LIKE ('%' || ${typed(term, true)} || '%')`;
}

/** `column` or one of its words opens with the typed term, both folded: such a hit ranks first (KEHOACH 9.20). */
export function foldedLeads(column: Prisma.Sql, term: string): Prisma.Sql {
  const lead = typed(term, true);
  return Prisma.sql`(${folded(column)} LIKE (${lead} || '%') OR ${folded(column)} LIKE ('% ' || ${lead} || '%'))`;
}

export function codeHas(column: Prisma.Sql, term: string): Prisma.Sql {
  return Prisma.sql`${column} ILIKE ('%' || ${typed(term, false)} || '%')`;
}

export function codeLeads(column: Prisma.Sql, term: string): Prisma.Sql {
  return Prisma.sql`${column} ILIKE (${typed(term, false)} || '%')`;
}

function nameOrCode(term: string): Prisma.Sql {
  return Prisma.sql`(${foldedHas(Prisma.sql`e."fullName"`, term)} OR ${codeHas(Prisma.sql`e."code"`, term)})`;
}

export async function employeesNamed(db: PrismaService, term: string): Promise<number[]> {
  const rows = await db.$queryRaw<{ id: number }[]>`SELECT e."id" FROM "Employee" e WHERE ${nameOrCode(term)}`;
  return rows.map((row) => row.id);
}

/** Everyone a typed name or code reaches, as an id filter; Prisma binds each listed id and stops at 32,766. */
export async function namedFilter(db: PrismaService, term: string): Promise<IdFilter> {
  const hit = await employeesNamed(db, term);
  if (hit.length <= kIdListMax) {
    return { in: hit };
  }
  const missed = await db.$queryRaw<{ id: number }[]>`SELECT e."id" FROM "Employee" e WHERE NOT ${nameOrCode(term)}`;
  return { notIn: missed.map((row) => row.id) };
}
