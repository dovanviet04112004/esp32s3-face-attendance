-- the contract of 20260925090000_release_publish: url is empty since a release arrives as a
-- file, and the image that stopped selecting it already runs (KEHOACH 9.22.3).
ALTER TABLE "Release" DROP COLUMN "url";
