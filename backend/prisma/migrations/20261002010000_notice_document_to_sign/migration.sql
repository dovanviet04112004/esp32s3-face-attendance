-- Each reader of a published version has a document to sign, closed as signed (KEHOACH 9.21.4).
-- New enum values go in a migration of their own; nothing here uses them yet.
ALTER TYPE "NoticeKind" ADD VALUE 'DOCUMENT_TO_SIGN';
ALTER TYPE "NoticeQueue" ADD VALUE 'DOCUMENTS';
ALTER TYPE "NoticeSubject" ADD VALUE 'DOCUMENT';
ALTER TYPE "NoticeOutcome" ADD VALUE 'SIGNED';
