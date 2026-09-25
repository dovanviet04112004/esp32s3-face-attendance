-- The job position group D02-LT asks for in columns 8 to 11 (KEHOACH 9.3).
CREATE TYPE "LaborCategory" AS ENUM ('MANAGER', 'HIGH_SKILLED', 'MID_SKILLED', 'OTHER');

ALTER TABLE "JobTitle" ADD COLUMN "laborCategory" "LaborCategory";
