-- The step an Update press queues behind the current offer, notes per language, and the models a firmware needs (KEHOACH 7.7).
ALTER TABLE "Device" ADD COLUMN     "otaNextActorId" TEXT,
ADD COLUMN     "otaNextReleaseId" UUID;

ALTER TABLE "Release" ADD COLUMN     "notesEn" TEXT,
ADD COLUMN     "notesVi" TEXT,
ADD COLUMN     "requiresModels" TEXT;
