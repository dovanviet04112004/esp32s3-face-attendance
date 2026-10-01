-- A kiosk's id is a subject only on a kiosk, in the heartbeat contract's own shape (KEHOACH 9.21.4).
-- Replaced by the five-shape NoticeItem_subjectId_shape added in the same statement, so no row goes unchecked.
ALTER TABLE "NoticeItem" DROP CONSTRAINT "NoticeItem_subjectId_shape",
  ADD CONSTRAINT "NoticeItem_subjectId_shape"
    CHECK (notice_subject_shape("subjectId") OR ("subjectType" = 'DEVICE' AND "subjectId" ~ '^[A-Za-z0-9_-]{4,32}$'));

-- Replaced by the five-shape Notification_subjectId_shape added in the same statement.
ALTER TABLE "Notification" DROP CONSTRAINT "Notification_subjectId_shape",
  ADD CONSTRAINT "Notification_subjectId_shape"
    CHECK (notice_subject_shape("subjectId") OR ("subjectType" = 'DEVICE' AND "subjectId" ~ '^[A-Za-z0-9_-]{4,32}$'));
