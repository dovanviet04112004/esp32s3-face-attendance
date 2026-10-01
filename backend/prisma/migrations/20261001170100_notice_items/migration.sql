-- The four shapes a subject id takes, so a subject never carries a sentence (KEHOACH 9.21.4):
-- a uuid, a number, a day, or a person-day.
CREATE FUNCTION notice_subject_shape(text) RETURNS boolean
    LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
    AS $$ SELECT $1 ~ '^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9]+|[0-9]{4}-[0-9]{2}-[0-9]{2}|[0-9]+:[0-9]{4}-[0-9]{2}-[0-9]{2})$' $$;

CREATE TABLE "NoticeItem" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "queue" "NoticeQueue" NOT NULL,
    "subjectType" "NoticeSubject" NOT NULL,
    "subjectId" TEXT NOT NULL,
    "employeeId" INTEGER,
    "level" "NoticeLevel" NOT NULL DEFAULT 'ACTION',
    "state" "NoticeItemState" NOT NULL DEFAULT 'OPEN',
    "outcome" "NoticeOutcome",
    "actorId" TEXT,
    "claimedById" TEXT,
    "claimedAt" TIMESTAMP(3),
    "dueAt" TIMESTAMP(3),
    "lastMark" INTEGER,
    "facts" JSONB NOT NULL DEFAULT '{}',
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),
    CONSTRAINT "NoticeItem_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "NoticeItem_subjectId_shape" CHECK (notice_subject_shape("subjectId")),
    CONSTRAINT "NoticeItem_closedAt_state" CHECK (("state" = 'OPEN') = ("closedAt" IS NULL))
);

CREATE UNIQUE INDEX "NoticeItem_key_key" ON "NoticeItem"("key");
CREATE INDEX "NoticeItem_state_queue_idx" ON "NoticeItem"("state", "queue");
CREATE INDEX "NoticeItem_subjectType_subjectId_idx" ON "NoticeItem"("subjectType", "subjectId");

ALTER TABLE "NoticeItem" ADD CONSTRAINT "NoticeItem_employeeId_fkey"
  FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NoticeItem" ADD CONSTRAINT "NoticeItem_actorId_fkey"
  FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "NoticeItem" ADD CONSTRAINT "NoticeItem_claimedById_fkey"
  FOREIGN KEY ("claimedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Every new column takes a null or a default: the release still running writes the old shape.
ALTER TABLE "Notification"
  ADD COLUMN "itemId" TEXT,
  ADD COLUMN "subjectType" "NoticeSubject",
  ADD COLUMN "subjectId" TEXT,
  ADD COLUMN "subjectEmployeeId" INTEGER,
  ADD COLUMN "dedupKey" TEXT,
  ADD COLUMN "facts" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN "remindCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "remindedAt" TIMESTAMP(3),
  ADD COLUMN "archivedAt" TIMESTAMP(3),
  ADD COLUMN "leftAt" TIMESTAMP(3),
  ADD CONSTRAINT "Notification_subjectId_shape" CHECK (notice_subject_shape("subjectId")),
  ADD CONSTRAINT "Notification_subject_pair" CHECK (("subjectType" IS NULL) = ("subjectId" IS NULL));

CREATE INDEX "Notification_itemId_idx" ON "Notification"("itemId");

ALTER TABLE "Notification" ADD CONSTRAINT "Notification_itemId_fkey"
  FOREIGN KEY ("itemId") REFERENCES "NoticeItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_subjectEmployeeId_fkey"
  FOREIGN KEY ("subjectEmployeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;
