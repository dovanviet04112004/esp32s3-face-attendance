/*
  Warnings:

  - You are about to drop the column `synced` on the `AttendanceRecord` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "AttendanceRecord" DROP COLUMN "synced",
ADD COLUMN     "capturedOffline" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "clockUnsynced" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "doorOpened" BOOLEAN NOT NULL DEFAULT false;
