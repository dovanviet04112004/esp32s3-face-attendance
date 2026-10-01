-- A day the build finds off its shift is work for the person it is about, until the day settles (KEHOACH 9.21.4).
-- New enum values go in a migration of their own; nothing here uses them yet.
ALTER TYPE "NoticeKind" ADD VALUE 'ATTENDANCE_EXCEPTION';
ALTER TYPE "NoticeQueue" ADD VALUE 'ATTENDANCE';
ALTER TYPE "NoticeSubject" ADD VALUE 'PERSON_DAY';
