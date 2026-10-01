-- A person's own screens hear that a punch of theirs arrived; the kind never writes a row (KEHOACH 9.21.4).
-- New enum values go in a migration of their own; nothing here uses them yet.
ALTER TYPE "NoticeKind" ADD VALUE 'PUNCH_RECORDED';
