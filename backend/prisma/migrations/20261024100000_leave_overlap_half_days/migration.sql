-- replaced by the half-day exclusion added below under the same name (KEHOACH 9.5).
ALTER TABLE "Request" DROP CONSTRAINT "Request_no_overlapping_leave";

-- Every date is two slots, morning 2d and afternoon 2d + 1: a whole day, or a half naming no part,
-- holds both, so the two halves of one date stand side by side. Rows that passed the date-range
-- exclusion never share a date, so every one of them passes this one.
ALTER TABLE "Request"
    ADD CONSTRAINT "Request_no_overlapping_leave"
    EXCLUDE USING gist (
        "employeeId" WITH =,
        int4range(
            ("fromDate" - DATE '2000-01-01') * 2
              + CASE WHEN "halfDay" AND "dayPart" = 'AFTERNOON' THEN 1 ELSE 0 END,
            ("toDate" - DATE '2000-01-01') * 2
              + CASE WHEN "halfDay" AND "dayPart" = 'MORNING' THEN 1 ELSE 2 END
        ) WITH &&
    )
    WHERE ("kind" = 'LEAVE' AND "state" IN ('PENDING', 'APPROVED'));
