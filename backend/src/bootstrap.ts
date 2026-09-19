import { ValidationPipe, type INestApplication } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import cookieParser from "cookie-parser";
import helmet from "helmet";

import { AllExceptionsFilter } from "./common/filters/all-exceptions.filter.js";
import { AuditInterceptor } from "./common/interceptors/audit.interceptor.js";
import type { Env } from "./config/env.schema.js";
import { AuditService } from "./modules/audit/audit.service.js";

// Row ids are BigInt, which JSON.stringify refuses outright, so every reply
// carrying one would be a 500 until it is told what to do with them.
(BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function toJSON(this: bigint) {
  return this.toString();
};

export function configure(app: INestApplication): void {
  const config = app.get(ConfigService<Env, true>);

  app.use(helmet());
  app.use(cookieParser());
  app.enableCors({
    origin: config.get("CORS_ORIGIN", { infer: true }).split(","),
    credentials: true,
  });
  // An undeclared field is a rejection, not something to ignore (CLAUDE.md 4.3).
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );

  const swagger = new DocumentBuilder()
    .setTitle("Kiosk attendance API")
    .setVersion("1")
    .addBearerAuth()
    .build();
  SwaggerModule.setup("docs", app, () => SwaggerModule.createDocument(app, swagger));

  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalInterceptors(new AuditInterceptor(app.get(AuditService)));
  app.enableShutdownHooks();
}
