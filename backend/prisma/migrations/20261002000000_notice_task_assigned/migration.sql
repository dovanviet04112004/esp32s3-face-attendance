-- Each task of an onboarding or offboarding run is work for whoever owns it, closed as completed (KEHOACH 9.21.4).
-- New enum values go in a migration of their own; nothing here uses them yet.
ALTER TYPE "NoticeKind" ADD VALUE 'TASK_ASSIGNED';
ALTER TYPE "NoticeQueue" ADD VALUE 'TASKS';
ALTER TYPE "NoticeSubject" ADD VALUE 'TASK';
ALTER TYPE "NoticeOutcome" ADD VALUE 'COMPLETED';
