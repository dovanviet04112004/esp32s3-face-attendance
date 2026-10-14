-- When the Update press behind a queued step happened: later steps only use releases published by then (KEHOACH 7.7).
ALTER TABLE "Device" ADD COLUMN     "otaPressedAt" TIMESTAMP(3);
