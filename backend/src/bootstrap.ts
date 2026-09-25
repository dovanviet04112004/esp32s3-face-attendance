import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  BadRequestException,
  HttpStatus,
  PayloadTooLargeException,
  ValidationPipe,
  type INestApplication,
  type ValidationError,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Reflector } from "@nestjs/core";
import { JwtService } from "@nestjs/jwt";
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from "@nestjs/swagger";
import cookieParser from "cookie-parser";
import express, { type NextFunction, type Request, type Response } from "express";
import helmet from "helmet";

import { API_AUTH } from "./common/decorators/api-docs.decorator.js";
import { AllExceptionsFilter } from "./common/filters/all-exceptions.filter.js";
import { AuditInterceptor } from "./common/interceptors/audit.interceptor.js";
import { ChangeInterceptor } from "./common/interceptors/change.interceptor.js";
import type { Env } from "./config/env.schema.js";
import { AuditService } from "./modules/audit/audit.service.js";
import { REFRESH_COOKIE } from "./modules/auth/auth.types.js";
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

function apiDocument(app: INestApplication): OpenAPIObject {
  const built = new DocumentBuilder()
    .setTitle("Kiosk attendance API")
    .setDescription(
      "Attendance kiosks, HR and payroll. Every error answers one shape, ErrorBody, whose message " +
        "is an UPPER_SNAKE code the client turns into a sentence; the api sends no prose.",
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
  return SwaggerModule.createDocument(app, built);
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

  if (config.get("API_DOCS_ENABLED", { infer: true })) {
    SwaggerModule.setup("docs", app, () => apiDocument(app));
  }

  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalInterceptors(
    new AuditInterceptor(app.get(AuditService), app.get(Reflector)),
    new ChangeInterceptor(app.get(RealtimeGateway)),
  );
  app.enableShutdownHooks();
}
