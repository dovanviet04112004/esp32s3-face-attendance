-- Why a stored punch waits for HR before it counts, and what HR decided (KEHOACH 9.8).
CREATE TYPE "PunchHold" AS ENUM ('LATE', 'CLOSED_PERIOD');

CREATE TYPE "PunchReview" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED');

ALTER TABLE "AttendanceRecord" ADD COLUMN "hold" "PunchHold",
ADD COLUMN "review" "PunchReview",
ADD COLUMN "reviewedById" TEXT,
ADD COLUMN "reviewedAt" TIMESTAMP(3),
ADD COLUMN "reviewNote" TEXT;

ALTER TABLE "AttendanceRecord" ADD CONSTRAINT "AttendanceRecord_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The HR queue reads only the waiting rows, oldest receipt first; the rest of the table stays out of it.
CREATE INDEX "AttendanceRecord_pending_idx" ON "AttendanceRecord"("receivedAt", "id") WHERE "review" = 'PENDING';
