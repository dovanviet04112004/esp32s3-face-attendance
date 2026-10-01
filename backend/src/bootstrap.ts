import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  BadRequestException,
  HttpStatus,
  NotFoundException,
  PayloadTooLargeException,
  ValidationPipe,
  type INestApplication,
  type ValidationError,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ModulesContainer, Reflector } from "@nestjs/core";
import { JwtService } from "@nestjs/jwt";
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from "@nestjs/swagger";
import cookieParser from "cookie-parser";
import express, { type NextFunction, type Request, type Response } from "express";
import helmet from "helmet";

import { DOCS } from "./common/cache/cache-keys.js";
import { API_AUTH } from "./common/decorators/api-docs.decorator.js";
import { ROLES_KEY } from "./common/decorators/roles.decorator.js";
import { AllExceptionsFilter } from "./common/filters/all-exceptions.filter.js";
import { AuditInterceptor } from "./common/interceptors/audit.interceptor.js";
import { ChangeInterceptor } from "./common/interceptors/change.interceptor.js";
import type { Env } from "./config/env.schema.js";
import { AuditService } from "./modules/audit/audit.service.js";
import { AuthService } from "./modules/auth/auth.service.js";
import { DOCS_COOKIE, DOCS_PATH, REFRESH_COOKIE } from "./modules/auth/auth.types.js";
import { IMPORT_MAX_BYTES, IMPORT_PATH } from "./modules/employees/import.js";
import { XLSX_MIME } from "./modules/employees/workbook.js";
import { FeedAdapter, RealtimeGateway } from "./modules/realtime/realtime.gateway.js";

const BEARER = "Bearer ";

// Row ids are BigInt, which JSON.stringify refuses outright, so every reply
// carrying one would be a 500 until it is told what to do with them.
(BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function toJSON(this: bigint) {
  return this.toString();
};

function failedFields(errors: ValidationError[], prefix = ""): string[] {
  return errors.flatMap((error) => {
    const path = `${prefix}${error.property}`;
    const own = Object.keys(error.constraints ?? {}).length > 0 ? [path] : [];
    return [...own, ...failedFields(error.children ?? [], `${path}.`)];
  });
}

function validationFailed(errors: ValidationError[]): BadRequestException {
  return new BadRequestException({ message: "VALIDATION_FAILED", fields: [...new Set(failedFields(errors))] });
}

// A body parser refuses ahead of every route, in prose; its client errors get codes here (CLAUDE.md 3.1).
function bodyFault(error: unknown, _req: Request, _res: Response, next: NextFunction): void {
  const fault = error as { type?: unknown; status?: unknown } | null;
  if (typeof fault?.type !== "string" || typeof fault.status !== "number" || fault.status >= 500) {
    return next(error);
  }
  if (fault.status === HttpStatus.PAYLOAD_TOO_LARGE) {
    return next(new PayloadTooLargeException("BODY_TOO_LARGE"));
  }
  next(new BadRequestException("BODY_INVALID"));
}

function signedIn(req: Request, jwt: JwtService, secret: string): boolean {
  const header = req.headers.authorization ?? "";
  try {
    const token = header.slice(BEARER.length);
    return header.startsWith(BEARER) && Boolean(jwt.verify(token, { secret, ignoreExpiration: true }));
  } catch {
    return false;
  }
}

// The test build sits one directory deeper than dist/, so the manifest is searched for upward.
function packageVersion(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(dir, "package.json")) && dirname(dir) !== dir) {
    dir = dirname(dir);
  }
  const file = join(dir, "package.json");
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as { version: string }).version : "0.0.0";
}

const TAGS: Record<string, string> = {
  auth: "Sign-in, sessions, passwords, and the pass that opens this reference.",
  users: "Accounts and their roles; opening sign-ins for employees.",
  employees: "Employee records, the directory, imports, hiring and leaving.",
  org: "Legal entities, departments, job titles and who reports to whom.",
  onboarding: "Checklists for joining and leaving.",
  "profile-changes": "Changes employees ask for on their own profile, applied once approved.",
  assets: "Company property lent to employees, and who has held each item.",
  certificates: "Employment certificates employees ask for and HR issues.",
  documents: "Company documents with versions, and who has read which version.",
  "biometric-consent": "Consent to face templates; withdrawing it erases the templates from every kiosk.",
  shifts: "Shift templates, who works which, and the roster.",
  attendance: "Punches from the kiosks.",
  timesheet: "Days built from punches, their corrections, and month summaries.",
  requests: "Leave, overtime and attendance-explanation requests, and deciding them.",
  reports: "Attendance and payroll reports and exports.",
  policy: "Payroll policy versions, each effective from a date: deductions, insurance, tax brackets, overtime.",
  compensation: "Base pay, allowances and raises, each effective from a date.",
  payroll: "Payroll periods, runs, payslips, bank files and payslip delivery.",
  advances: "Salary advances, paid out and recovered through payroll.",
  "payslip-disputes": "Questions an employee raises about a payslip, and the answers.",
  devices: "Kiosks: registration, approval, revocation, status and commands.",
  enrollment: "Who each kiosk holds, and capturing their faces.",
  releases: "Firmware and model releases for the kiosks: publish, offer, download.",
  notifications: "In-app notices, push subscriptions and their preferences.",
  search: "One search across the records and pages the caller may see.",
  audit: "Who changed what, and when; read only.",
  health: "Liveness of the api and what it depends on.",
};

const CALLERS: Record<string, string> = {
  [API_AUTH.user]: "Roles: any signed-in account.",
  [API_AUTH.device]: "Caller: a kiosk, with its device token.",
  [API_AUTH.publisher]: "Caller: CI or the training machine, with the publish token.",
  [API_AUTH.refresh]: "Caller: a browser holding the refresh cookie.",
};

// The roles RolesGuard enforces, a method's own over its class's, keyed by the operationId Swagger derives.
function rolesByOperation(app: INestApplication): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const moduleRef of app.get(ModulesContainer).values()) {
    for (const { metatype } of moduleRef.controllers.values()) {
      const proto = (metatype as { prototype: Record<string, unknown> }).prototype;
      for (const name of Object.getOwnPropertyNames(proto).filter((key) => key !== "constructor")) {
        const roles = (Reflect.getMetadata(ROLES_KEY, proto[name] as object) ?? Reflect.getMetadata(ROLES_KEY, metatype as object)) as string[] | undefined;
        if (roles?.length) {
          found.set(`${(metatype as { name: string }).name}_${name}`, roles);
        }
      }
    }
  }
  return found;
}

function withCallers(document: OpenAPIObject, roles: Map<string, string[]>): OpenAPIObject {
  for (const item of Object.values(document.paths)) {
    for (const operation of [item.get, item.post, item.put, item.patch, item.delete]) {
      if (!operation) {
        continue;
      }
      const scheme = Object.keys(operation.security?.[0] ?? {})[0];
      const named = roles.get(operation.operationId ?? "");
      const callers = named ? `Roles: ${named.join(", ")}.` : scheme ? CALLERS[scheme] : "Public: no token.";
      operation.description = operation.description ? `**${callers}**\n\n${operation.description}` : `**${callers}**`;
    }
  }
  return document;
}

// Anything short of a standing session answers as a route that does not exist (KEHOACH 7.2).
function docsGate(auth: AuthService, secure: boolean) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const hidden = () => next(new NotFoundException("ROUTE_NOT_FOUND"));
    const pass = typeof req.query.pass === "string" ? req.query.pass : null;
    if (pass !== null) {
      void auth.openDocs(pass).then((session) => {
        if (session === null) {
          return hidden();
        }
        const lifeMs = DOCS.session(session).ttlSeconds * 1000;
        res.cookie(DOCS_COOKIE, session, { httpOnly: true, secure, sameSite: "strict", path: DOCS_PATH, maxAge: lifeMs });
        res.redirect(303, DOCS_PATH);
      }, hidden);
      return;
    }
    const session = (req.cookies as Record<string, string | undefined>)[DOCS_COOKIE];
    if (!session) {
      return hidden();
    }
    void auth.docsSessionStands(session).then((stands) => (stands ? next() : hidden()), hidden);
  };
}

function apiDocument(app: INestApplication): OpenAPIObject {
  const built = new DocumentBuilder()
    .setTitle("Kiosk attendance API")
    .setDescription(
      "Attendance kiosks, HR and payroll. Every error answers one shape, ErrorBody, whose message " +
        "is an UPPER_SNAKE code the client turns into a sentence; the api sends no prose. Each " +
        "operation opens with who may call it. On production this reference is read-only and " +
        "opens only for an ADMIN, from Settings.",
    )
    .setVersion(packageVersion())
    .addBearerAuth(
      { type: "http", description: "Access token from POST /auth/login or POST /auth/refresh" },
      API_AUTH.user,
    )
    .addBearerAuth(
      { type: "http", description: "Kiosk token from POST /devices/register or POST /devices/me/token" },
      API_AUTH.device,
    )
    .addBearerAuth(
      { type: "http", bearerFormat: "opaque", description: "RELEASE_PUBLISH_TOKEN, held by CI and the training machine" },
      API_AUTH.publisher,
    )
    .addCookieAuth(
      REFRESH_COOKIE,
      { type: "apiKey", description: "httpOnly refresh token, read only by POST /auth/refresh" },
      API_AUTH.refresh,
    )
    .build();
  built.tags = Object.entries(TAGS).map(([name, description]) => ({ name, description }));
  return withCallers(SwaggerModule.createDocument(app, built), rolesByOperation(app));
}

export function configure(app: INestApplication): void {
  const config = app.get(ConfigService<Env, true>);
  const origins = config.get("CORS_ORIGIN", { infer: true }).split(",");

  const hops = config.get("TRUST_PROXY_HOPS", { infer: true });
  if (hops > 0) {
    app.getHttpAdapter().getInstance().set("trust proxy", hops);
  }
  app.use(helmet());
  // Only the service worker's per-account drawer may keep a reply (KEHOACH 4.7).
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  app.use(cookieParser());
  // Ahead of the parsers, so a refused body still reaches the browser readable.
  app.enableCors({ origin: origins, credentials: true });
  app.useWebSocketAdapter(new FeedAdapter(app, origins));
  // Nest drops its own parser if the stack holds one named jsonParser.
  const readLargeBody = express.json({ limit: IMPORT_MAX_BYTES });
  const readLargeFile = express.raw({ type: [XLSX_MIME, "text/csv"], limit: IMPORT_MAX_BYTES });
  const jwt = new JwtService();
  const accessSecret = config.get("JWT_ACCESS_SECRET", { infer: true });
  // Parsing precedes every guard: only a token this api signed, even an expired one, earns the large limit.
  app.use(IMPORT_PATH, (req: Request, res: Response, next: NextFunction) => {
    if (!signedIn(req, jwt, accessSecret)) {
      return next();
    }
    readLargeBody(req, res, (error?: unknown) => (error ? next(error) : readLargeFile(req, res, next)));
  });
  // Named jsonParser and urlencodedParser, so Nest adds none of its own behind bodyFault.
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(bodyFault);
  // An undeclared field is a rejection, not something to ignore (CLAUDE.md 4.3).
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      exceptionFactory: validationFailed,
    }),
  );

  const docs = config.get("API_DOCS", { infer: true });
  if (docs === "admin") {
    app.use(DOCS_PATH, docsGate(app.get(AuthService), config.get("NODE_ENV", { infer: true }) === "production"));
  }
  if (docs !== "off") {
    SwaggerModule.setup("docs", app, () => apiDocument(app), {
      jsonDocumentUrl: "docs/json",
      yamlDocumentUrl: "docs/yaml",
      // A reference opened on live data only reads; trying calls belongs to a developer's own stack.
      swaggerOptions: docs === "admin" ? { supportedSubmitMethods: [] } : {},
    });
  }

  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalInterceptors(
    new AuditInterceptor(app.get(AuditService), app.get(Reflector)),
    new ChangeInterceptor(app.get(RealtimeGateway)),
  );
  app.enableShutdownHooks();
}
