-- CreateEnum
CREATE TYPE "CertificateKind" AS ENUM ('EMPLOYMENT', 'INCOME');

-- CreateEnum
CREATE TYPE "CertificateState" AS ENUM ('REQUESTED', 'ISSUED', 'REJECTED');

-- CreateTable
CREATE TABLE "Certificate" (
    "id" TEXT NOT NULL,
    "employeeId" INTEGER NOT NULL,
    "kind" "CertificateKind" NOT NULL,
    "state" "CertificateState" NOT NULL DEFAULT 'REQUESTED',
    "purpose" TEXT NOT NULL,
    "months" INTEGER,
    "serial" TEXT,
    "issuedAt" TIMESTAMP(3),
    "issuedById" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Certificate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Certificate_serial_key" ON "Certificate"("serial");

-- CreateIndex
CREATE INDEX "Certificate_state_createdAt_idx" ON "Certificate"("state", "createdAt");

-- CreateIndex
CREATE INDEX "Certificate_employeeId_createdAt_idx" ON "Certificate"("employeeId", "createdAt");

-- AddForeignKey
ALTER TABLE "Certificate" ADD CONSTRAINT "Certificate_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Certificate" ADD CONSTRAINT "Certificate_issuedById_fkey" FOREIGN KEY ("issuedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The serial is minted by the database, so two people issuing at the same
-- moment cannot be handed the same number (KEHOACH 9.23 rule 2).
CREATE SEQUENCE "certificate_serial_seq" AS bigint START 1;
