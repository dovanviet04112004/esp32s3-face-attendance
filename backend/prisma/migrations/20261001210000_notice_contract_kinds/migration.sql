-- The work of a contract or a probation running out, and the verbs it closes with (KEHOACH 9.18 items 1-2,
-- 9.21.4). New enum values go in a migration of their own; nothing here uses them yet.
ALTER TYPE "NoticeKind" ADD VALUE 'CONTRACT_DUE';
ALTER TYPE "NoticeKind" ADD VALUE 'PROBATION_DUE';
ALTER TYPE "NoticeQueue" ADD VALUE 'CONTRACTS_DUE';
ALTER TYPE "NoticeQueue" ADD VALUE 'PROBATION_DUE';
ALTER TYPE "NoticeOutcome" ADD VALUE 'RENEWED';
ALTER TYPE "NoticeOutcome" ADD VALUE 'RESOLVED';
