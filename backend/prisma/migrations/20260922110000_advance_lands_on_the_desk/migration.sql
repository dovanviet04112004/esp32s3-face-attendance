-- An advance asks what somebody earns and still owes, which KEHOACH 9.4 closes
-- to MANAGER, so it names no approver and lands on the desk (KEHOACH 9.15).
-- replaced by THE_DESK in leave.service.ts, which names who may decide.
ALTER TABLE "SalaryAdvance" DROP CONSTRAINT IF EXISTS "SalaryAdvance_approverId_fkey";
-- the contract of "decidedById" answers who decided, and the audit log keeps it.
ALTER TABLE "SalaryAdvance" DROP COLUMN IF EXISTS "approverId";

-- A notice about an advance borrows the REQUEST_* kinds; this reference is what
-- tells it apart from one about a leave request (KEHOACH 9.21.4).
ALTER TABLE "Notification" ADD COLUMN "advanceId" TEXT;
