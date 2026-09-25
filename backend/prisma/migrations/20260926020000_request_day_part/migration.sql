-- Which half of the day a half-day request takes; null on a whole day (KEHOACH 9.5).
CREATE TYPE "DayPart" AS ENUM ('MORNING', 'AFTERNOON');

ALTER TABLE "Request" ADD COLUMN "dayPart" "DayPart";
