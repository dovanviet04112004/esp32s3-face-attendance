import { Global, Module } from "@nestjs/common";

import { RedisService } from "../../database/redis.service.js";
import { CacheService } from "./cache.service.js";

@Global()
@Module({
  providers: [RedisService, CacheService],
  exports: [RedisService, CacheService],
})
export class CacheModule {}
