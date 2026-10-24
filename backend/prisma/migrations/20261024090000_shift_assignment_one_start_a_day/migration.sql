-- One shift starts a person on a given day (KEHOACH 9.15).
-- Of two rows starting one person on one day, keep the one the day build reads: the larger id, as no row records when it was made.
DELETE FROM "ShiftAssignment" a
 USING "ShiftAssignment" b
 WHERE a."employeeId" = b."employeeId"
   AND a."validFrom" = b."validFrom"
   AND a."id" < b."id";

CREATE UNIQUE INDEX "ShiftAssignment_employeeId_validFrom_key" ON "ShiftAssignment"("employeeId", "validFrom");
