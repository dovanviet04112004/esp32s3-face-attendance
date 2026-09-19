import { ConfigService } from "@nestjs/config";
import { NestFactory } from "@nestjs/core";

import { AppModule } from "./app.module.js";
import { configure } from "./bootstrap.js";
import type { Env } from "./config/env.schema.js";

async function start(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  configure(app);
  await app.listen(app.get(ConfigService<Env, true>).get("PORT", { infer: true }));
}

void start();
