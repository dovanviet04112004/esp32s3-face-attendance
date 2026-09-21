
-- CreateEnum
CREATE TYPE "DocumentKind" AS ENUM ('POLICY', 'HANDBOOK', 'NOTICE');

-- CreateTable
CREATE TABLE "Document" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "kind" "DocumentKind" NOT NULL DEFAULT 'POLICY',
    "departmentId" TEXT,
    "jobTitleId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentVersion" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "body" TEXT NOT NULL,
    "summary" TEXT,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedById" TEXT,

    CONSTRAINT "DocumentVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentAck" (
    "id" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "employeeId" INTEGER NOT NULL,
    "ackAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentAck_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PersonnelFileType" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT true,
    "validMonths" INTEGER,
    "ordinal" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PersonnelFileType_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PersonnelFile" (
    "id" TEXT NOT NULL,
    "employeeId" INTEGER NOT NULL,
    "typeId" TEXT NOT NULL,
    "receivedAt" DATE NOT NULL,
    "receivedById" TEXT,
    "expiresAt" DATE,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PersonnelFile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Document_code_key" ON "Document"("code");

-- CreateIndex
CREATE INDEX "Document_active_departmentId_idx" ON "Document"("active", "departmentId");

-- CreateIndex
CREATE INDEX "Document_active_jobTitleId_idx" ON "Document"("active", "jobTitleId");

-- CreateIndex
CREATE INDEX "DocumentVersion_documentId_publishedAt_idx" ON "DocumentVersion"("documentId", "publishedAt");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentVersion_documentId_version_key" ON "DocumentVersion"("documentId", "version");

-- CreateIndex
CREATE INDEX "DocumentAck_employeeId_ackAt_idx" ON "DocumentAck"("employeeId", "ackAt");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentAck_versionId_employeeId_key" ON "DocumentAck"("versionId", "employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "PersonnelFileType_code_key" ON "PersonnelFileType"("code");

-- CreateIndex
CREATE INDEX "PersonnelFileType_active_ordinal_idx" ON "PersonnelFileType"("active", "ordinal");

-- CreateIndex
CREATE INDEX "PersonnelFile_typeId_expiresAt_idx" ON "PersonnelFile"("typeId", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "PersonnelFile_employeeId_typeId_key" ON "PersonnelFile"("employeeId", "typeId");

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_jobTitleId_fkey" FOREIGN KEY ("jobTitleId") REFERENCES "JobTitle"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentVersion" ADD CONSTRAINT "DocumentVersion_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentAck" ADD CONSTRAINT "DocumentAck_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "DocumentVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentAck" ADD CONSTRAINT "DocumentAck_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PersonnelFile" ADD CONSTRAINT "PersonnelFile_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PersonnelFile" ADD CONSTRAINT "PersonnelFile_typeId_fkey" FOREIGN KEY ("typeId") REFERENCES "PersonnelFileType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- A version number is a counter, and a published version is never edited, so
-- the wording it carries can never be empty (KEHOACH 9.22.4).
ALTER TABLE "DocumentVersion"
    ADD CONSTRAINT "DocumentVersion_version_positive" CHECK ("version" >= 1),
    ADD CONSTRAINT "DocumentVersion_body_not_empty" CHECK (length(btrim("body")) > 0);

ALTER TABLE "PersonnelFileType"
    ADD CONSTRAINT "PersonnelFileType_validity_positive"
    CHECK ("validMonths" IS NULL OR "validMonths" > 0);

ALTER TABLE "PersonnelFile"
    ADD CONSTRAINT "PersonnelFile_expiry_after_receipt"
    CHECK ("expiresAt" IS NULL OR "expiresAt" >= "receivedAt");
