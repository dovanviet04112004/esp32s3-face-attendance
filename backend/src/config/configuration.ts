import { ConfigModule } from "@nestjs/config";

import { validateEnv } from "./env.schema.js";

/** ConfigModule wired to fail at boot when the environment is incomplete. */
export const configModule = ConfigModule.forRoot({
  isGlobal: true,
  cache: true,
  validate: validateEnv,
});
