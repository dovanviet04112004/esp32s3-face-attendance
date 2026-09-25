-- Allowances become a catalogue the pay desk keeps; a pay record copies the
-- rules of the type it picked, so existing rows stay valid with no type (KEHOACH 9.6).
CREATE TABLE "AllowanceType" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "taxable" BOOLEAN NOT NULL DEFAULT true,
    "insurable" BOOLEAN NOT NULL DEFAULT false,
    "taxFreeCap" DECIMAL(14,0),
    "d02Column" INTEGER,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AllowanceType_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AllowanceType_d02Column_check" CHECK ("d02Column" IS NULL OR "d02Column" BETWEEN 13 AND 17),
    CONSTRAINT "AllowanceType_taxFreeCap_check" CHECK ("taxFreeCap" IS NULL OR "taxFreeCap" >= 0)
);

CREATE UNIQUE INDEX "AllowanceType_code_key" ON "AllowanceType"("code");

ALTER TABLE "CompensationAllowance" ADD COLUMN "typeId" TEXT;
ALTER TABLE "CompensationAllowance" ADD COLUMN "taxFreeCap" DECIMAL(14,0);
ALTER TABLE "CompensationAllowance" ADD COLUMN "d02Column" INTEGER;

CREATE INDEX "CompensationAllowance_typeId_idx" ON "CompensationAllowance"("typeId");

ALTER TABLE "CompensationAllowance" ADD CONSTRAINT "CompensationAllowance_typeId_fkey" FOREIGN KEY ("typeId") REFERENCES "AllowanceType"("id") ON DELETE SET NULL ON UPDATE CASCADE;
