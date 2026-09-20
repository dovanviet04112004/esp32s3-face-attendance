-- Anything that happened to a person is traced from the person, so pay,
-- contracts and biometric access all sit under the employee they concern.

-- A contract row named the contract; the employee is one join away.
UPDATE "AuditLog" a
SET "subjectType" = 'employee',
    "subjectId" = c."employeeId"::text,
    "meta" = coalesce(a."meta", '{}'::jsonb) || jsonb_build_object('contractId', a."subjectId")
FROM "EmploymentContract" c
WHERE a."subjectType" = 'contract' AND a."subjectId" = c."id";

-- A contract deleted since leaves nothing to join to; the id stays in meta.
UPDATE "AuditLog"
SET "subjectType" = 'employee',
    "subjectId" = '',
    "meta" = coalesce("meta", '{}'::jsonb) || jsonb_build_object('contractId', "subjectId")
WHERE "subjectType" = 'contract';

UPDATE "AuditLog" SET "subjectType" = 'employee' WHERE "subjectType" IN ('biometric', 'pay');

-- Offboarding named the employee by code while everything else used the id.
UPDATE "AuditLog" a
SET "subjectId" = e."id"::text,
    "meta" = coalesce(a."meta", '{}'::jsonb) || jsonb_build_object('code', a."subjectId")
FROM "Employee" e
WHERE a."action" = 'employee.offboard' AND a."subjectId" = e."code";

-- A reorganisation put the number of people moved where the subject belongs.
UPDATE "AuditLog"
SET "meta" = coalesce("meta", '{}'::jsonb) || jsonb_build_object('moved', "subjectId"::int),
    "subjectId" = 'selection'
WHERE "action" = 'org.reorg' AND "subjectId" ~ '^[0-9]+$';

UPDATE "AuditLog" SET "action" = 'pay.bulkRaise', "subjectType" = 'org'
WHERE "action" = 'pay.bulkRaise';

UPDATE "AuditLog" SET "action" = 'advance.pay' WHERE "action" = 'payroll.advancePay';
