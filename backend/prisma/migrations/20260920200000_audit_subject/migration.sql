-- The column held a route pattern for some rows and an entity id for others.
ALTER TABLE "AuditLog" RENAME COLUMN "target" TO "subjectId";
ALTER TABLE "AuditLog" ADD COLUMN "subjectType" TEXT;

-- Rows the global net wrote carried the http verb as their action.
UPDATE "AuditLog"
SET "subjectType" = 'route',
    "meta" = coalesce("meta", '{}'::jsonb) || jsonb_build_object('method', "action"),
    "action" = 'route.write'
WHERE "action" NOT LIKE '%.%';

-- The contract state lived in the action name; it is a fact about the row.
UPDATE "AuditLog"
SET "meta" = coalesce("meta", '{}'::jsonb)
             || jsonb_build_object('state', upper(split_part("action", '.', 2))),
    "action" = 'contract.decide'
WHERE "action" LIKE 'contract.%' AND "action" <> 'contract.create';

UPDATE "AuditLog" SET "action" = 'pay.create' WHERE "action" = 'compensation.create';
UPDATE "AuditLog" SET "action" = 'pay.bulkRaise' WHERE "action" = 'compensation.bulkRaise';
UPDATE "AuditLog" SET "action" = 'payroll.advancePay' WHERE "action" = 'advance.pay';
UPDATE "AuditLog" SET "action" = 'org.holidayCreate' WHERE "action" = 'holiday.create';
UPDATE "AuditLog" SET "action" = 'org.holidayDelete' WHERE "action" = 'holiday.delete';

UPDATE "AuditLog"
SET "subjectType" = split_part("action", '.', 1)
WHERE "subjectType" IS NULL;

ALTER TABLE "AuditLog" ALTER COLUMN "subjectType" SET NOT NULL;

-- CreateIndex
CREATE INDEX "AuditLog_subjectType_subjectId_ts_idx" ON "AuditLog"("subjectType", "subjectId", "ts");

-- CreateIndex
CREATE INDEX "AuditLog_actorId_ts_idx" ON "AuditLog"("actorId", "ts");
