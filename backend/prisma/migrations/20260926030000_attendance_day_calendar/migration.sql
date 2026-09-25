-- What the calendar says a day is, apart from what the person did on it, so a
-- weekend or a holiday worked still prices its overtime at its own rate (KEHOACH 9.8).
CREATE TYPE "DayCalendar" AS ENUM ('WORKDAY', 'WEEKEND', 'HOLIDAY', 'UNPAID_HOLIDAY');

ALTER TABLE "AttendanceDay" ADD COLUMN "calendar" "DayCalendar" NOT NULL DEFAULT 'WORKDAY';

UPDATE "AttendanceDay" SET "calendar" = 'WEEKEND' WHERE EXTRACT(ISODOW FROM "date") IN (6, 7);

-- An entity's own holiday wins over a company-wide one on the same date.
UPDATE "AttendanceDay" d
   SET "calendar" = CASE WHEN h."paid" THEN 'HOLIDAY'::"DayCalendar" ELSE 'UNPAID_HOLIDAY'::"DayCalendar" END
  FROM "Employee" e, "Holiday" h
 WHERE e."id" = d."employeeId"
   AND h."date" = d."date"
   AND (
     h."legalEntityId" = e."legalEntityId"
     OR (
       h."legalEntityId" IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM "Holiday" own
          WHERE own."date" = d."date" AND own."legalEntityId" = e."legalEntityId"
       )
     )
   );
