import { Module } from "@nestjs/common";

import { configModule } from "./config/configuration.js";
import { DatabaseModule } from "./database/database.module.js";

@Module({
  imports: [configModule, DatabaseModule],
})
export class AppModule {}
