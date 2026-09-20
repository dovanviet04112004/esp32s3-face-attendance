import { Module } from "@nestjs/common";

import { ScopeModule } from "../../common/scope/scope.module.js";
import { AuthModule } from "../auth/auth.module.js";
import { CertificatesController } from "./certificates.controller.js";
import { CertificatesService } from "./certificates.service.js";

@Module({
  imports: [AuthModule, ScopeModule],
  controllers: [CertificatesController],
  providers: [CertificatesService],
  exports: [CertificatesService],
})
export class CertificatesModule {}
