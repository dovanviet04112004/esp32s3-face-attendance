-- Who pressed the Update in flight, a one-step press too, so its end can be told to them (KEHOACH 7.7).
ALTER TABLE "Device" ADD COLUMN     "otaPressedById" TEXT;
