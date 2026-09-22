-- An advance asks what somebody earns and still owes, which KEHOACH 9.4 closes
-- to MANAGER, so it names no approver and lands on the desk (KEHOACH 9.15).
-- Who actually decided stays in "decidedById" and in the audit log.
ALTER TABLE "SalaryAdvance" DROP CONSTRAINT IF EXISTS "SalaryAdvance_approverId_fkey";
ALTER TABLE "SalaryAdvance" DROP COLUMN IF EXISTS "approverId";

-- A notice about an advance borrows the REQUEST_* kinds; this reference is what
-- tells it apart from one about a leave request (KEHOACH 9.21.4).
ALTER TABLE "Notification" ADD COLUMN "advanceId" TEXT;
