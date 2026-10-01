-- Moves the notices of the old shape into subjects, facts, keys and items (KEHOACH 9.21.4).
-- Each statement picks only rows still unmoved, so running the file again changes nothing.

-- Subject, facts and key in one pass, so each old row is rewritten once; which dispute a slip-only
-- notice meant and which slip a period-only one meant are settled in KEHOACH 9.21.4.
WITH subject AS (
  SELECT DISTINCT ON ("id") "id", "type", "sid", "emp"
    FROM (
      SELECT n."id", 1 AS "rank", 'REQUEST' AS "type", n."requestId" AS "sid", s."employeeId" AS "emp"
        FROM "Notification" n LEFT JOIN "Request" s ON s."id" = n."requestId"
       WHERE n."dedupKey" IS NULL AND notice_subject_shape(n."requestId")
      UNION ALL
      SELECT n."id", 2, 'ADVANCE', n."advanceId", s."employeeId"
        FROM "Notification" n LEFT JOIN "SalaryAdvance" s ON s."id" = n."advanceId"
       WHERE n."dedupKey" IS NULL AND notice_subject_shape(n."advanceId")
      UNION ALL
      SELECT n."id", 3, 'CERTIFICATE', n."certificateId", s."employeeId"
        FROM "Notification" n LEFT JOIN "Certificate" s ON s."id" = n."certificateId"
       WHERE n."dedupKey" IS NULL AND notice_subject_shape(n."certificateId")
      UNION ALL
      SELECT n."id", 4, 'PROFILE_CHANGE', n."profileChangeId", s."employeeId"
        FROM "Notification" n LEFT JOIN "ProfileChange" s ON s."id" = n."profileChangeId"
       WHERE n."dedupKey" IS NULL AND notice_subject_shape(n."profileChangeId")
      UNION ALL
      SELECT n."id", 5, 'DEPENDENT', n."dependentId", s."employeeId"
        FROM "Notification" n LEFT JOIN "Dependent" s ON s."id" = n."dependentId"
       WHERE n."dedupKey" IS NULL AND notice_subject_shape(n."dependentId")
      UNION ALL
      SELECT n."id", 6, 'CONTRACT', n."contractId", s."employeeId"
        FROM "Notification" n LEFT JOIN "EmploymentContract" s ON s."id" = n."contractId"
       WHERE n."dedupKey" IS NULL AND notice_subject_shape(n."contractId")
      UNION ALL
      (SELECT DISTINCT ON (n."id") n."id", 7, 'DISPUTE', d."id", d."employeeId"
         FROM "Notification" n JOIN "PayslipDispute" d ON d."payslipId" = n."payslipId"
        WHERE n."dedupKey" IS NULL AND n."kind" IN ('REQUEST_WAITING', 'DISPUTE_ANSWERED')
        ORDER BY n."id",
                 ABS(EXTRACT(EPOCH FROM (CASE WHEN n."kind" = 'DISPUTE_ANSWERED'
                                              THEN COALESCE(d."answeredAt", d."createdAt")
                                              ELSE d."createdAt" END) - n."createdAt")),
                 d."createdAt" DESC)
      UNION ALL
      SELECT n."id", 8, 'PAYSLIP', n."payslipId", s."employeeId"
        FROM "Notification" n LEFT JOIN "Payslip" s ON s."id" = n."payslipId"
       WHERE n."dedupKey" IS NULL AND n."kind" = 'PAYSLIP_ISSUED' AND notice_subject_shape(n."payslipId")
      UNION ALL
      (SELECT DISTINCT ON (n."id") n."id", 9, 'PAYSLIP', p."id", p."employeeId"
         FROM "Notification" n
         JOIN "User" u ON u."id" = n."userId"
         JOIN "Payslip" p ON p."periodId" = n."periodId" AND p."employeeId" = u."employeeId" AND p."state" <> 'DRAFT'
        WHERE n."dedupKey" IS NULL AND n."kind" = 'PAYSLIP_ISSUED' AND n."payslipId" IS NULL
        ORDER BY n."id", p."createdAt", p."id")
    ) AS found
   ORDER BY "id", "rank"
),
moved AS (
  SELECT n."id", s."type", s."sid", s."emp",
         CASE
           WHEN n."kind" = 'CONTRACT_ENDING' AND n."daysLeft" IS NOT NULL
             THEN jsonb_build_object('daysLeft', n."daysLeft")
           WHEN n."kind" IN ('REQUEST_STALLED', 'REQUEST_WAITING') AND n."daysWaited" IS NOT NULL
             THEN jsonb_build_object('daysWaited', n."daysWaited")
           WHEN n."kind" = 'REQUEST_DECIDED' AND n."approved" IS NOT NULL
             THEN jsonb_build_object('outcome', CASE WHEN NOT n."approved" THEN 'REJECTED'
                                                    WHEN s."type" = 'CERTIFICATE' THEN 'ISSUED'
                                                    ELSE 'APPROVED' END)
           ELSE n."facts"
         END AS "facts",
         CASE
           WHEN s."type" IS NULL
             THEN lower(replace(n."kind"::text, '_', '-')) || ':row:' || n."id"
           WHEN n."kind" = 'REQUEST_WAITING'
                AND s."type" IN ('REQUEST', 'ADVANCE', 'CERTIFICATE', 'PROFILE_CHANGE', 'DISPUTE', 'DEPENDENT')
             THEN CASE s."type"
                    WHEN 'REQUEST' THEN 'requests:'
                    WHEN 'ADVANCE' THEN CASE WHEN n."approved" THEN 'advances-to-pay:' ELSE 'advances-to-decide:' END
                    WHEN 'CERTIFICATE' THEN 'certificates:'
                    WHEN 'PROFILE_CHANGE' THEN 'profile-changes:'
                    WHEN 'DISPUTE' THEN 'disputes:'
                    WHEN 'DEPENDENT' THEN 'dependents:'
                  END || s."sid"
           ELSE lower(replace(n."kind"::text, '_', '-')) || ':' || lower(replace(s."type", '_', '-')) || ':' || s."sid"
         END AS "key"
    FROM "Notification" n
    LEFT JOIN subject s ON s."id" = n."id"
   WHERE n."dedupKey" IS NULL
)
UPDATE "Notification" n
   SET "subjectType" = moved."type"::"NoticeSubject", "subjectId" = moved."sid",
       "subjectEmployeeId" = moved."emp", "facts" = moved."facts", "dedupKey" = moved."key"
  FROM moved
 WHERE n."id" = moved."id";

-- One item per subject somebody was told is waiting, and per subject still waiting that nobody was
-- told about. State, outcome and who handled it come off the business row.
WITH told AS (
  SELECT DISTINCT "dedupKey" AS "key" FROM "Notification"
   WHERE "kind" = 'REQUEST_WAITING' AND "dedupKey" LIKE 'requests:%'
),
marks AS (
  SELECT "requestId", MAX("daysWaited") AS "lastMark" FROM "Notification"
   WHERE "requestId" IS NOT NULL AND "daysWaited" IS NOT NULL
   GROUP BY "requestId"
)
INSERT INTO "NoticeItem" ("id", "key", "queue", "subjectType", "subjectId", "employeeId", "state", "outcome",
                          "actorId", "lastMark", "openedAt", "closedAt")
SELECT gen_random_uuid()::text, 'requests:' || r."id", 'REQUESTS', 'REQUEST', r."id", r."employeeId",
       (CASE r."state" WHEN 'PENDING' THEN 'OPEN' WHEN 'CANCELLED' THEN 'WITHDRAWN' ELSE 'DONE' END)::"NoticeItemState",
       (CASE r."state" WHEN 'APPROVED' THEN 'APPROVED' WHEN 'REJECTED' THEN 'REJECTED' END)::"NoticeOutcome",
       CASE r."state" WHEN 'CANCELLED' THEN (SELECT u."id" FROM "User" u WHERE u."employeeId" = r."employeeId")
                      ELSE r."decidedById" END,
       marks."lastMark", r."createdAt",
       CASE WHEN r."state" = 'PENDING' THEN NULL ELSE COALESCE(r."decidedAt", r."updatedAt") END
  FROM "Request" r
  LEFT JOIN told ON told."key" = 'requests:' || r."id"
  LEFT JOIN marks ON marks."requestId" = r."id"
 WHERE r."state" = 'PENDING' OR told."key" IS NOT NULL
ON CONFLICT ("key") DO NOTHING;

WITH told AS (
  SELECT DISTINCT "dedupKey" AS "key" FROM "Notification"
   WHERE "kind" = 'REQUEST_WAITING' AND "dedupKey" LIKE 'advances-to-decide:%'
)
INSERT INTO "NoticeItem" ("id", "key", "queue", "subjectType", "subjectId", "employeeId", "state", "outcome",
                          "actorId", "openedAt", "closedAt")
SELECT gen_random_uuid()::text, 'advances-to-decide:' || a."id", 'ADVANCES_TO_DECIDE', 'ADVANCE', a."id", a."employeeId",
       (CASE a."state" WHEN 'PENDING' THEN 'OPEN' WHEN 'CANCELLED' THEN 'WITHDRAWN' ELSE 'DONE' END)::"NoticeItemState",
       (CASE WHEN a."state" = 'REJECTED' THEN 'REJECTED'
             WHEN a."state" IN ('APPROVED', 'PAID', 'SETTLED') THEN 'APPROVED' END)::"NoticeOutcome",
       CASE a."state" WHEN 'CANCELLED' THEN (SELECT u."id" FROM "User" u WHERE u."employeeId" = a."employeeId")
                      ELSE a."decidedById" END,
       a."requestedAt",
       CASE WHEN a."state" = 'PENDING' THEN NULL ELSE COALESCE(a."decidedAt", now()) END
  FROM "SalaryAdvance" a
  LEFT JOIN told ON told."key" = 'advances-to-decide:' || a."id"
 WHERE a."state" = 'PENDING' OR told."key" IS NOT NULL
ON CONFLICT ("key") DO NOTHING;

-- The advance does not record who paid it; the audit trail does (KEHOACH 9.24).
WITH told AS (
  SELECT DISTINCT "dedupKey" AS "key" FROM "Notification"
   WHERE "kind" = 'REQUEST_WAITING' AND "dedupKey" LIKE 'advances-to-pay:%'
)
INSERT INTO "NoticeItem" ("id", "key", "queue", "subjectType", "subjectId", "employeeId", "state", "outcome",
                          "actorId", "openedAt", "closedAt")
SELECT gen_random_uuid()::text, 'advances-to-pay:' || a."id", 'ADVANCES_TO_PAY', 'ADVANCE', a."id", a."employeeId",
       (CASE WHEN a."state" = 'APPROVED' THEN 'OPEN'
             WHEN a."state" IN ('PAID', 'SETTLED') THEN 'DONE' ELSE 'EXPIRED' END)::"NoticeItemState",
       (CASE WHEN a."state" IN ('PAID', 'SETTLED') THEN 'PAID' END)::"NoticeOutcome",
       CASE WHEN a."state" IN ('PAID', 'SETTLED') THEN
         (SELECT l."actorId" FROM "AuditLog" l
           WHERE l."subjectType" = 'advance' AND l."subjectId" = a."id" AND l."action" = 'advance.pay'
           ORDER BY l."ts" DESC LIMIT 1)
       END,
       COALESCE(a."decidedAt", a."requestedAt"),
       CASE WHEN a."state" = 'APPROVED' THEN NULL ELSE COALESCE(a."paidAt", now()) END
  FROM "SalaryAdvance" a
  LEFT JOIN told ON told."key" = 'advances-to-pay:' || a."id"
 WHERE a."state" = 'APPROVED' OR told."key" IS NOT NULL
ON CONFLICT ("key") DO NOTHING;

WITH told AS (
  SELECT DISTINCT "dedupKey" AS "key" FROM "Notification"
   WHERE "kind" = 'REQUEST_WAITING' AND "dedupKey" LIKE 'certificates:%'
)
INSERT INTO "NoticeItem" ("id", "key", "queue", "subjectType", "subjectId", "employeeId", "state", "outcome",
                          "actorId", "openedAt", "closedAt")
SELECT gen_random_uuid()::text, 'certificates:' || c."id", 'CERTIFICATES', 'CERTIFICATE', c."id", c."employeeId",
       (CASE c."state" WHEN 'REQUESTED' THEN 'OPEN' ELSE 'DONE' END)::"NoticeItemState",
       (CASE c."state" WHEN 'ISSUED' THEN 'ISSUED' WHEN 'REJECTED' THEN 'REJECTED' END)::"NoticeOutcome",
       c."issuedById", c."createdAt",
       CASE c."state" WHEN 'REQUESTED' THEN NULL WHEN 'ISSUED' THEN COALESCE(c."issuedAt", c."updatedAt")
                      ELSE c."updatedAt" END
  FROM "Certificate" c
  LEFT JOIN told ON told."key" = 'certificates:' || c."id"
 WHERE c."state" = 'REQUESTED' OR told."key" IS NOT NULL
ON CONFLICT ("key") DO NOTHING;

WITH told AS (
  SELECT DISTINCT "dedupKey" AS "key" FROM "Notification"
   WHERE "kind" = 'REQUEST_WAITING' AND "dedupKey" LIKE 'profile-changes:%'
)
INSERT INTO "NoticeItem" ("id", "key", "queue", "subjectType", "subjectId", "employeeId", "state", "outcome",
                          "actorId", "openedAt", "closedAt")
SELECT gen_random_uuid()::text, 'profile-changes:' || p."id", 'PROFILE_CHANGES', 'PROFILE_CHANGE', p."id", p."employeeId",
       (CASE p."state" WHEN 'PENDING' THEN 'OPEN' WHEN 'CANCELLED' THEN 'WITHDRAWN' ELSE 'DONE' END)::"NoticeItemState",
       (CASE p."state" WHEN 'APPROVED' THEN 'APPROVED' WHEN 'REJECTED' THEN 'REJECTED' END)::"NoticeOutcome",
       p."decidedById", p."createdAt",
       CASE WHEN p."state" = 'PENDING' THEN NULL ELSE COALESCE(p."decidedAt", p."updatedAt") END
  FROM "ProfileChange" p
  LEFT JOIN told ON told."key" = 'profile-changes:' || p."id"
 WHERE p."state" = 'PENDING' OR told."key" IS NOT NULL
ON CONFLICT ("key") DO NOTHING;

WITH told AS (
  SELECT DISTINCT "dedupKey" AS "key" FROM "Notification"
   WHERE "kind" = 'REQUEST_WAITING' AND "dedupKey" LIKE 'disputes:%'
)
INSERT INTO "NoticeItem" ("id", "key", "queue", "subjectType", "subjectId", "employeeId", "state", "outcome",
                          "actorId", "dueAt", "openedAt", "closedAt")
SELECT gen_random_uuid()::text, 'disputes:' || d."id", 'DISPUTES', 'DISPUTE', d."id", d."employeeId",
       (CASE d."state" WHEN 'OPEN' THEN 'OPEN' WHEN 'WITHDRAWN' THEN 'WITHDRAWN' ELSE 'DONE' END)::"NoticeItemState",
       (CASE WHEN d."state" = 'ANSWERED' THEN d."outcome"::text END)::"NoticeOutcome",
       CASE d."state" WHEN 'WITHDRAWN' THEN (SELECT u."id" FROM "User" u WHERE u."employeeId" = d."employeeId")
                      ELSE d."answeredById" END,
       d."dueAt", d."createdAt",
       CASE WHEN d."state" = 'OPEN' THEN NULL ELSE COALESCE(d."answeredAt", d."updatedAt") END
  FROM "PayslipDispute" d
  LEFT JOIN told ON told."key" = 'disputes:' || d."id"
 WHERE d."state" = 'OPEN' OR told."key" IS NOT NULL
ON CONFLICT ("key") DO NOTHING;

WITH told AS (
  SELECT DISTINCT "dedupKey" AS "key" FROM "Notification"
   WHERE "kind" = 'REQUEST_WAITING' AND "dedupKey" LIKE 'dependents:%'
)
INSERT INTO "NoticeItem" ("id", "key", "queue", "subjectType", "subjectId", "employeeId", "state", "outcome",
                          "actorId", "openedAt", "closedAt")
SELECT gen_random_uuid()::text, 'dependents:' || x."id", 'DEPENDENTS', 'DEPENDENT', x."id", x."employeeId",
       (CASE x."state" WHEN 'PENDING' THEN 'OPEN' ELSE 'DONE' END)::"NoticeItemState",
       (CASE WHEN x."state" = 'REJECTED' THEN 'REJECTED'
             WHEN x."state" IN ('ACTIVE', 'ENDED') THEN 'APPROVED' END)::"NoticeOutcome",
       x."decidedById", x."createdAt",
       CASE WHEN x."state" = 'PENDING' THEN NULL ELSE COALESCE(x."decidedAt", x."updatedAt") END
  FROM "Dependent" x
  LEFT JOIN told ON told."key" = 'dependents:' || x."id"
 WHERE x."state" = 'PENDING' OR told."key" IS NOT NULL
ON CONFLICT ("key") DO NOTHING;

-- A waiting row joins its item, and a row of an item already closed reads as read from the close.
UPDATE "Notification" n
   SET "itemId" = i."id",
       "readAt" = CASE WHEN n."readAt" IS NULL AND i."state" <> 'OPEN' THEN i."closedAt" ELSE n."readAt" END
  FROM "NoticeItem" i
 WHERE n."itemId" IS NULL AND n."kind" = 'REQUEST_WAITING' AND i."key" = n."dedupKey";

-- Rows sharing a key are reminders of one thing: the newest stays and counts the others.
WITH copies AS (
  SELECT "id",
         COUNT(*) OVER (PARTITION BY "userId", "dedupKey") AS "copies",
         ROW_NUMBER() OVER (PARTITION BY "userId", "dedupKey" ORDER BY "createdAt" DESC, "id" DESC) AS "rank"
    FROM "Notification"
   WHERE "dedupKey" IS NOT NULL
)
UPDATE "Notification" n
   SET "remindCount" = n."remindCount" + copies."copies" - 1, "remindedAt" = n."createdAt"
  FROM copies
 WHERE n."id" = copies."id" AND copies."rank" = 1 AND copies."copies" > 1;

DELETE FROM "Notification" n
 USING (SELECT "id", ROW_NUMBER() OVER (PARTITION BY "userId", "dedupKey" ORDER BY "createdAt" DESC, "id" DESC) AS "rank"
          FROM "Notification"
         WHERE "dedupKey" IS NOT NULL) copies
 WHERE n."id" = copies."id" AND copies."rank" > 1;
