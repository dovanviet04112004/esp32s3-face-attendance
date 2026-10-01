-- A failing backup is work for the ADMINs that clears itself once a watch finds nothing wrong (KEHOACH 9.21.4).
-- New enum values go in a migration of their own; nothing here uses them yet.
ALTER TYPE "NoticeKind" ADD VALUE 'BACKUP_ALERT';
ALTER TYPE "NoticeQueue" ADD VALUE 'BACKUP';
ALTER TYPE "NoticeSubject" ADD VALUE 'BACKUP';
