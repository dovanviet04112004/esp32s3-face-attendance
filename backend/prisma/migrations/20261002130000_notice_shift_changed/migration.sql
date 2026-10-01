-- A person hears when their shift changes from today on, gathered into one push (KEHOACH 9.21.4).
-- New enum values go in a migration of their own; nothing here uses them yet.
ALTER TYPE "NoticeKind" ADD VALUE 'SHIFT_CHANGED';
