-- Everyone paid in a period hears that their month's timesheet closed with it (KEHOACH 9.21.4).
-- New enum values go in a migration of their own; nothing here uses them yet.
ALTER TYPE "NoticeKind" ADD VALUE 'TIMESHEET_MONTH_CLOSED';
ALTER TYPE "NoticeSubject" ADD VALUE 'PAYROLL_PERIOD';
