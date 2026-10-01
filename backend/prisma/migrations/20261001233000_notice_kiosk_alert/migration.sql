-- What a kiosk reports, or a kiosk falling silent, is work for the ADMINs (KEHOACH 9.21.4).
-- New enum values go in a migration of their own; nothing here uses them yet.
ALTER TYPE "NoticeKind" ADD VALUE 'KIOSK_ALERT';
ALTER TYPE "NoticeQueue" ADD VALUE 'KIOSK';
ALTER TYPE "NoticeSubject" ADD VALUE 'DEVICE';
