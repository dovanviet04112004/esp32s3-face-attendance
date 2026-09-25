-- A leave type may count every calendar day, not working days only (KEHOACH 9.5).
ALTER TABLE "LeaveType" ADD COLUMN "calendarDays" BOOLEAN NOT NULL DEFAULT false;
