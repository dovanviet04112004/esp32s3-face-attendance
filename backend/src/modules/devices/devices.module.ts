import { Module } from "@nestjs/common";

import { DevicesService } from "./devices.service.js";

@Module({
  providers: [DevicesService],
  exports: [DevicesService],
})
export class DevicesModule {}
