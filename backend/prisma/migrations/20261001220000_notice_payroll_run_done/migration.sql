-- A payroll run that ends tells whoever pressed it, about that run (KEHOACH 9.21.4).
-- New enum values go in a migration of their own; nothing here uses them yet.
ALTER TYPE "NoticeKind" ADD VALUE 'PAYROLL_RUN_DONE';
ALTER TYPE "NoticeSubject" ADD VALUE 'PAYROLL_RUN';
