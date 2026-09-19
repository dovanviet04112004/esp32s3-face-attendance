-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ADMIN', 'HR', 'VIEWER');

-- CreateEnum
CREATE TYPE "DeviceStatus" AS ENUM ('PENDING', 'APPROVED', 'REVOKED');

-- CreateEnum
CREATE TYPE "EnrollmentState" AS ENUM ('ASSIGNED', 'ENROLLED', 'REVOKED');

-- CreateEnum
CREATE TYPE "CommandState" AS ENUM ('QUEUED', 'SENT', 'DONE', 'REJECTED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "RolloutState" AS ENUM ('DRAFT', 'ROLLING', 'PAUSED', 'COMPLETED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'VIEWER',
    "refreshTokenHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Employee" (
    "id" SERIAL NOT NULL,
    "code" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "department" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "embeddingVersion" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Employee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FaceTemplate" (
    "id" TEXT NOT NULL,
    "employeeId" INTEGER NOT NULL,
    "templateIdx" INTEGER NOT NULL,
    "embedding" BYTEA NOT NULL,
    "scale" DOUBLE PRECISION NOT NULL,
    "quality" INTEGER,
    "capturedAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FaceTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Device" (
    "id" VARCHAR(32) NOT NULL,
    "serial" TEXT,
    "name" TEXT,
    "location" TEXT,
    "status" "DeviceStatus" NOT NULL DEFAULT 'PENDING',
    "tokenHash" TEXT,
    "fwVersion" TEXT,
    "modelVersion" TEXT,
    "rosterVersion" INTEGER NOT NULL DEFAULT 0,
    "lastSeenAt" TIMESTAMP(3),
    "online" BOOLEAN NOT NULL DEFAULT false,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Device_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceEnrollment" (
    "deviceId" VARCHAR(32) NOT NULL,
    "employeeId" INTEGER NOT NULL,
    "state" "EnrollmentState" NOT NULL DEFAULT 'ASSIGNED',
    "templateIdx" INTEGER,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeviceEnrollment_pkey" PRIMARY KEY ("deviceId","employeeId")
);

-- CreateTable
CREATE TABLE "DeviceCommand" (
    "cmdId" UUID NOT NULL,
    "deviceId" VARCHAR(32) NOT NULL,
    "action" TEXT NOT NULL,
    "payload" JSONB,
    "issuedById" TEXT,
    "expiresAt" TIMESTAMP(3),
    "state" "CommandState" NOT NULL DEFAULT 'QUEUED',
    "resultNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeviceCommand_pkey" PRIMARY KEY ("cmdId")
);

-- CreateTable
CREATE TABLE "DeviceEvent" (
    "id" BIGSERIAL NOT NULL,
    "deviceId" VARCHAR(32) NOT NULL,
    "type" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "employeeId" INTEGER,
    "livenessScore" DOUBLE PRECISION,
    "cmdId" UUID,
    "errorCode" INTEGER,
    "message" TEXT,
    "ts" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeviceEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttendanceRecord" (
    "id" BIGSERIAL NOT NULL,
    "localId" VARCHAR(20) NOT NULL,
    "deviceId" VARCHAR(32) NOT NULL,
    "employeeId" INTEGER NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL,
    "direction" TEXT NOT NULL,
    "score" DOUBLE PRECISION,
    "livenessScore" DOUBLE PRECISION,
    "synced" BOOLEAN NOT NULL DEFAULT true,
    "photoUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AttendanceRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Shift" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL,
    "graceMinutes" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Shift_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShiftAssignment" (
    "id" TEXT NOT NULL,
    "shiftId" TEXT NOT NULL,
    "employeeId" INTEGER NOT NULL,
    "validFrom" TIMESTAMP(3) NOT NULL,
    "validTo" TIMESTAMP(3),

    CONSTRAINT "ShiftAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Release" (
    "releaseId" UUID NOT NULL,
    "target" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "minFwVersion" TEXT,
    "runId" TEXT,
    "rolloutState" "RolloutState" NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Release_pkey" PRIMARY KEY ("releaseId")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" BIGSERIAL NOT NULL,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "meta" JSONB,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Employee_code_key" ON "Employee"("code");

-- CreateIndex
CREATE UNIQUE INDEX "FaceTemplate_employeeId_templateIdx_key" ON "FaceTemplate"("employeeId", "templateIdx");

-- CreateIndex
CREATE UNIQUE INDEX "Device_serial_key" ON "Device"("serial");

-- CreateIndex
CREATE INDEX "Device_status_idx" ON "Device"("status");

-- CreateIndex
CREATE INDEX "DeviceCommand_deviceId_state_idx" ON "DeviceCommand"("deviceId", "state");

-- CreateIndex
CREATE INDEX "DeviceEvent_deviceId_ts_idx" ON "DeviceEvent"("deviceId", "ts");

-- CreateIndex
CREATE INDEX "DeviceEvent_type_ts_idx" ON "DeviceEvent"("type", "ts");

-- CreateIndex
CREATE INDEX "AttendanceRecord_employeeId_ts_idx" ON "AttendanceRecord"("employeeId", "ts");

-- CreateIndex
CREATE INDEX "AttendanceRecord_ts_idx" ON "AttendanceRecord"("ts");

-- CreateIndex
CREATE UNIQUE INDEX "AttendanceRecord_deviceId_localId_key" ON "AttendanceRecord"("deviceId", "localId");

-- CreateIndex
CREATE UNIQUE INDEX "Shift_name_key" ON "Shift"("name");

-- CreateIndex
CREATE UNIQUE INDEX "ShiftAssignment_shiftId_employeeId_validFrom_key" ON "ShiftAssignment"("shiftId", "employeeId", "validFrom");

-- CreateIndex
CREATE UNIQUE INDEX "Release_target_version_key" ON "Release"("target", "version");

-- CreateIndex
CREATE INDEX "AuditLog_ts_idx" ON "AuditLog"("ts");

-- AddForeignKey
ALTER TABLE "FaceTemplate" ADD CONSTRAINT "FaceTemplate_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceEnrollment" ADD CONSTRAINT "DeviceEnrollment_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceEnrollment" ADD CONSTRAINT "DeviceEnrollment_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceCommand" ADD CONSTRAINT "DeviceCommand_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceCommand" ADD CONSTRAINT "DeviceCommand_issuedById_fkey" FOREIGN KEY ("issuedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceEvent" ADD CONSTRAINT "DeviceEvent_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceRecord" ADD CONSTRAINT "AttendanceRecord_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceRecord" ADD CONSTRAINT "AttendanceRecord_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftAssignment" ADD CONSTRAINT "ShiftAssignment_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "Shift"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftAssignment" ADD CONSTRAINT "ShiftAssignment_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
