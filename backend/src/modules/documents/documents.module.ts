import { Module } from "@nestjs/common";

import { ScopeModule } from "../../common/scope/scope.module.js";
import { AuthModule } from "../auth/auth.module.js";
import { DocumentsController } from "./documents.controller.js";
import { DocumentsService } from "./documents.service.js";

@Module({
  imports: [AuthModule, ScopeModule],
  controllers: [DocumentsController],
  providers: [DocumentsService],
  exports: [DocumentsService],
})
export class DocumentsModule {}
