-- A request's days split by calendar year, and a year's balance that knows what
-- it carried out, so carry-over is counted once (KEHOACH 9.5).
ALTER TABLE "Request" ADD COLUMN "nextYearDays" DECIMAL(5,1) NOT NULL DEFAULT 0;

ALTER TABLE "LeaveBalance"
    ADD COLUMN "carriedOut" DECIMAL(5,1) NOT NULL DEFAULT 0,
    ADD COLUMN "closedAt" TIMESTAMP(3);

ALTER TABLE "Request"
    ADD CONSTRAINT "Request_next_year_within_days" CHECK ("nextYearDays" >= 0 AND "nextYearDays" <= "days");

ALTER TABLE "LeaveBalance"
    ADD CONSTRAINT "LeaveBalance_carried_out_not_negative" CHECK ("carriedOut" >= 0);
