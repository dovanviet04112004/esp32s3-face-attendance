import { ValidationPipe } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { NestFactory } from "@nestjs/core";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import helmet from "helmet";

import { AppModule } from "./app.module.js";
import type { Env } from "./config/env.schema.js";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService<Env, true>);

  app.use(helmet());
  app.enableCors({
    origin: config.get("CORS_ORIGIN", { infer: true }).split(","),
    credentials: true,
  });
  // Nothing a device sends is trusted, so unknown fields are a rejection
  // rather than something to ignore (CLAUDE.md 4.3).
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );

  const swagger = new DocumentBuilder()
    .setTitle("Kiosk attendance API")
    .setVersion("1")
    .addBearerAuth()
    .build();
  SwaggerModule.setup("docs", app, () => SwaggerModule.createDocument(app, swagger));

  app.enableShutdownHooks();
  await app.listen(config.get("PORT", { infer: true }));
}

void bootstrap();
