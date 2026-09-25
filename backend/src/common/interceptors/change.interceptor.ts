import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from "@nestjs/common";
import type { Request } from "express";
import { tap, type Observable } from "rxjs";

import type { AccessClaims } from "../../modules/auth/auth.types.js";
import { FEED, RealtimeGateway, type About } from "../../modules/realtime/realtime.gateway.js";

const READ_ONLY = new Set(["GET", "HEAD", "OPTIONS"]);
const SILENT = new Set(["auth"]);
const OWN_LOGIN = new Set(["notifications"]);
// Every login reads these, so a write nobody owns still reaches everyone (KEHOACH 9.4).
const SHARED = new Set([
  "holidays",
  "leave-types",
  "departments",
  "job-titles",
  "legal-entities",
  "org",
  "documents",
  "shifts",
]);

type Asker = Request & { user?: Partial<AccessClaims> };

/** What a `change` carries: the route's own words, never an id or a value. */
export interface Change {
  resources: string[];
}

type Owned = { id?: unknown; managerId?: unknown; employeeId?: unknown } | null | undefined;

// An employee row owns itself; its manager's socket scope predates a new or moved row (KEHOACH 9.4).
function ownersOfRow(row: Owned, root: string): unknown[] {
  if (row?.employeeId !== undefined) {
    return [row.employeeId];
  }
  return root === "employees" ? [row?.id, row?.managerId] : [];
}

// A batch answers its rows under `rows`, beside the counts about them.
function rowsOf(result: unknown): unknown[] {
  if (Array.isArray(result)) {
    return result;
  }
  const held = (result as { rows?: unknown } | null | undefined)?.rows;
  return Array.isArray(held) ? held : [result];
}

function ownersOf(result: unknown, root: string, named: number[]): About {
  const rows = rowsOf(result);
  const owners = new Set<number>(named);
  for (const row of rows) {
    for (const owner of ownersOfRow(row as Owned, root)) {
      if (typeof owner === "number") {
        owners.add(owner);
      }
    }
  }
  return owners.size === 0 ? null : [...owners];
}

@Injectable()
export class ChangeInterceptor implements NestInterceptor {
  constructor(private readonly feed: RealtimeGateway) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<Asker>();
    const pattern: string = req.route?.path ?? "";
    const resources = pattern.split("/").filter((word) => word !== "" && !word.startsWith(":"));
    const actor = req.user?.sub;
    if (
      READ_ONLY.has(req.method) ||
      actor === undefined ||
      resources.length === 0 ||
      SILENT.has(resources[0])
    ) {
      return next.handle();
    }
    return next.handle().pipe(tap((result) => this.announce(req, actor, { resources }, result)));
  }

  private announce(req: Asker, actor: string, change: Change, result: unknown): void {
    const [root] = change.resources;
    if (OWN_LOGIN.has(root)) {
      this.feed.tell(actor, FEED.change, change);
      return;
    }
    const about = this.ownerOf(req, root, result);
    if (about === null && SHARED.has(root)) {
      this.feed.announce(FEED.change, change);
      return;
    }
    this.feed.publish(FEED.change, change, about);
  }

  private ownerOf(req: Asker, root: string, result: unknown): About {
    if (root === "me") {
      return req.user?.employeeId ?? null;
    }
    const named = Number(req.params.employeeId ?? (root === "employees" ? req.params.id : undefined));
    return ownersOf(result, root, Number.isInteger(named) ? [named] : []);
  }
}
