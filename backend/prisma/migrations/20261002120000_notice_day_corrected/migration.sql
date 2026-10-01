-- A person hears when somebody else corrects a day of theirs by hand (KEHOACH 9.21.4).
-- New enum values go in a migration of their own; nothing here uses them yet.
ALTER TYPE "NoticeKind" ADD VALUE 'DAY_CORRECTED';
