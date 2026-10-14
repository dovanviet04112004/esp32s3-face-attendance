-- A release the fleet has not all taken, and an update its presser hears finished (KEHOACH 9.21.4).
-- New enum values go in a migration of their own; nothing here uses them yet.
ALTER TYPE "NoticeKind" ADD VALUE 'RELEASE_AVAILABLE';
ALTER TYPE "NoticeKind" ADD VALUE 'UPDATE_FINISHED';
ALTER TYPE "NoticeQueue" ADD VALUE 'RELEASES';
ALTER TYPE "NoticeSubject" ADD VALUE 'RELEASE';
