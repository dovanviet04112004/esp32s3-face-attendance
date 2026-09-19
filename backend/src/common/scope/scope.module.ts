import { Global, Module } from "@nestjs/common";

import { ScopeService } from "./scope.service.js";

@Global()
@Module({
  providers: [ScopeService],
  exports: [ScopeService],
})
export class ScopeModule {}
