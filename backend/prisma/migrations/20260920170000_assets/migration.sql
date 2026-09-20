-- CreateEnum
CREATE TYPE "AssetState" AS ENUM ('IN_STOCK', 'ISSUED', 'RETURNED', 'RETIRED', 'LOST');

-- CreateEnum
CREATE TYPE "AssetCondition" AS ENUM ('NEW', 'GOOD', 'WORN', 'DAMAGED');

-- CreateTable
CREATE TABLE "Asset" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "serialNo" TEXT,
    "state" "AssetState" NOT NULL DEFAULT 'IN_STOCK',
    "holderId" INTEGER,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Asset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssetTransfer" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "employeeId" INTEGER NOT NULL,
    "issued" BOOLEAN NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "condition" "AssetCondition" NOT NULL DEFAULT 'GOOD',
    "note" TEXT,
    "byUserId" TEXT,

    CONSTRAINT "AssetTransfer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Asset_code_key" ON "Asset"("code");

-- CreateIndex
CREATE INDEX "Asset_state_kind_idx" ON "Asset"("state", "kind");

-- CreateIndex
CREATE INDEX "Asset_holderId_idx" ON "Asset"("holderId");

-- CreateIndex
CREATE INDEX "AssetTransfer_assetId_at_idx" ON "AssetTransfer"("assetId", "at");

-- CreateIndex
CREATE INDEX "AssetTransfer_employeeId_issued_idx" ON "AssetTransfer"("employeeId", "issued");

-- AddForeignKey
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_holderId_fkey" FOREIGN KEY ("holderId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetTransfer" ADD CONSTRAINT "AssetTransfer_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetTransfer" ADD CONSTRAINT "AssetTransfer_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetTransfer" ADD CONSTRAINT "AssetTransfer_byUserId_fkey" FOREIGN KEY ("byUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
