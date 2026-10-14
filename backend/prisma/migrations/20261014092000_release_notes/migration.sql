-- The publisher's Vietnamese summary and the details built from git (KEHOACH 7.7).
ALTER TABLE "Release" ADD COLUMN     "notes" TEXT,
ADD COLUMN     "summary" VARCHAR(200);
