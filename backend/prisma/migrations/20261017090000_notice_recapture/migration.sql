-- A person whose kiosk runs a newer recognition model than every face they hold (KEHOACH 9.21.4).
-- New enum values go in a migration of their own; nothing here uses them yet.
ALTER TYPE "NoticeKind" ADD VALUE 'FACE_RECAPTURE';
ALTER TYPE "NoticeQueue" ADD VALUE 'RECAPTURE';
ALTER TYPE "NoticeSubject" ADD VALUE 'EMPLOYEE';
