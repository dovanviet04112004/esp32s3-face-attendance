import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module.js";
import { OrgController } from "./org.controller.js";
import { OrgService } from "./org.service.js";

@Module({
  imports: [AuthModule],
  controllers: [OrgController],
  providers: [OrgService],
  exports: [OrgService],
})
export class OrgModule {}
