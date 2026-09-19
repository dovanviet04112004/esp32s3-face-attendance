-- CreateEnum
CREATE TYPE "ContractKind" AS ENUM ('PROBATION', 'FIXED_TERM', 'INDEFINITE', 'SEASONAL', 'INTERNSHIP');

-- CreateEnum
CREATE TYPE "ContractState" AS ENUM ('DRAFT', 'ACTIVE', 'ENDED', 'TERMINATED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "Role" ADD VALUE 'PAYROLL';
ALTER TYPE "Role" ADD VALUE 'MANAGER';
ALTER TYPE "Role" ADD VALUE 'EMPLOYEE';

-- AlterTable
ALTER TABLE "Employee" ADD COLUMN     "bankAccount" TEXT,
ADD COLUMN     "bankName" TEXT,
ADD COLUMN     "dateOfBirth" DATE,
ADD COLUMN     "departmentId" TEXT,
ADD COLUMN     "hireDate" DATE,
ADD COLUMN     "jobTitleId" TEXT,
ADD COLUMN     "leaveDate" DATE,
ADD COLUMN     "legalEntityId" TEXT,
ADD COLUMN     "managerId" INTEGER,
ADD COLUMN     "nationalId" TEXT,
ADD COLUMN     "personalEmail" TEXT,
ADD COLUMN     "phone" TEXT,
ADD COLUMN     "photoUrl" TEXT,
ADD COLUMN     "socialInsuranceNo" TEXT,
ADD COLUMN     "taxCode" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "active" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "employeeId" INTEGER;

-- CreateTable
CREATE TABLE "LegalEntity" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "taxCode" TEXT,
    "address" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LegalEntity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Department" (
    "id" TEXT NOT NULL,
    "legalEntityId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "parentId" TEXT,
    "costCentre" TEXT,
    "headId" INTEGER,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Department_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobTitle" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "grade" INTEGER,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JobTitle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmploymentContract" (
    "id" TEXT NOT NULL,
    "employeeId" INTEGER NOT NULL,
    "kind" "ContractKind" NOT NULL,
    "state" "ContractState" NOT NULL DEFAULT 'DRAFT',
    "number" TEXT,
    "startDate" DATE NOT NULL,
    "endDate" DATE,
    "probationEnd" DATE,
    "signedAt" TIMESTAMP(3),
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmploymentContract_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LegalEntity_code_key" ON "LegalEntity"("code");

-- CreateIndex
CREATE INDEX "Department_parentId_idx" ON "Department"("parentId");

-- CreateIndex
CREATE UNIQUE INDEX "Department_legalEntityId_code_key" ON "Department"("legalEntityId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "JobTitle_code_key" ON "JobTitle"("code");

-- CreateIndex
CREATE INDEX "EmploymentContract_employeeId_startDate_idx" ON "EmploymentContract"("employeeId", "startDate");

-- CreateIndex
CREATE INDEX "EmploymentContract_state_endDate_idx" ON "EmploymentContract"("state", "endDate");

-- CreateIndex
CREATE INDEX "EmploymentContract_state_probationEnd_idx" ON "EmploymentContract"("state", "probationEnd");

-- CreateIndex
CREATE INDEX "Employee_departmentId_active_idx" ON "Employee"("departmentId", "active");

-- CreateIndex
CREATE INDEX "Employee_managerId_idx" ON "Employee"("managerId");

-- CreateIndex
CREATE INDEX "Employee_legalEntityId_active_idx" ON "Employee"("legalEntityId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "User_employeeId_key" ON "User"("employeeId");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Department" ADD CONSTRAINT "Department_legalEntityId_fkey" FOREIGN KEY ("legalEntityId") REFERENCES "LegalEntity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Department" ADD CONSTRAINT "Department_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Department"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmploymentContract" ADD CONSTRAINT "EmploymentContract_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_legalEntityId_fkey" FOREIGN KEY ("legalEntityId") REFERENCES "LegalEntity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_jobTitleId_fkey" FOREIGN KEY ("jobTitleId") REFERENCES "JobTitle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_managerId_fkey" FOREIGN KEY ("managerId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Lift the department strings into the tree before the column goes. Doing it
-- after the foreign keys exist means a bad row fails here rather than later.
INSERT INTO "LegalEntity" ("id", "code", "name", "active", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, 'DEFAULT', 'Công ty', true, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "LegalEntity" WHERE "code" = 'DEFAULT');

INSERT INTO "Department" ("id", "legalEntityId", "code", "name", "active", "createdAt", "updatedAt")
-- Sequential codes, not a slug of the name: stripping diacritics collides
-- ("Nhân sự" and "Nhận sự" both flatten to NH-N-S) and a collision here aborts
-- the migration. The name carries the meaning; HR renames the code later.
SELECT gen_random_uuid()::text,
       (SELECT "id" FROM "LegalEntity" WHERE "code" = 'DEFAULT'),
       'PB' || lpad((row_number() OVER (ORDER BY x.name))::text, 4, '0'),
       x.name,
       true, now(), now()
FROM (SELECT DISTINCT trim("department") AS name FROM "Employee"
      WHERE "department" IS NOT NULL AND trim("department") <> '') x;

UPDATE "Employee" e
SET "departmentId" = d."id"
FROM "Department" d
WHERE d."name" = trim(e."department");

-- Everyone belongs to the entity, department or not: payroll and the D02-LT
-- filing are per entity (KEHOACH 9.20).
UPDATE "Employee"
SET "legalEntityId" = (SELECT "id" FROM "LegalEntity" WHERE "code" = 'DEFAULT')
WHERE "legalEntityId" IS NULL;

-- AlterTable
ALTER TABLE "Employee" DROP COLUMN "department";
