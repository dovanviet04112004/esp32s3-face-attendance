-- CreateEnum
CREATE TYPE "ConsentState" AS ENUM ('GRANTED', 'WITHDRAWN');

-- CreateTable
CREATE TABLE "BiometricConsent" (
    "id" TEXT NOT NULL,
    "employeeId" INTEGER NOT NULL,
    "noticeVersion" TEXT NOT NULL,
    "state" "ConsentState" NOT NULL DEFAULT 'GRANTED',
    "method" TEXT NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "withdrawnAt" TIMESTAMP(3),
    "recordedById" TEXT,
    "note" TEXT,

    CONSTRAINT "BiometricConsent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BiometricConsent_employeeId_state_idx" ON "BiometricConsent"("employeeId", "state");

-- CreateIndex
CREATE INDEX "BiometricConsent_state_grantedAt_idx" ON "BiometricConsent"("state", "grantedAt");

-- AddForeignKey
ALTER TABLE "BiometricConsent" ADD CONSTRAINT "BiometricConsent_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- One live agreement per person, enforced by the database rather than by a
-- read-then-write in the service, which two requests can both pass.
CREATE UNIQUE INDEX "BiometricConsent_one_live_per_employee"
    ON "BiometricConsent" ("employeeId")
    WHERE "state" = 'GRANTED';
