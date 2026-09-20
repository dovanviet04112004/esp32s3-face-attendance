import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module.js";
import { SearchController } from "./search.controller.js";
import { SearchService } from "./search.service.js";

@Module({
  imports: [AuthModule],
  controllers: [SearchController],
  providers: [SearchService],
})
export class SearchModule {}
