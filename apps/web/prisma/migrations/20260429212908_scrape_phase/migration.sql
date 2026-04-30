-- Add a free-text phase column for live progress reporting from the
-- content script. Nullable; defaults to NULL when no phase reported yet.
ALTER TABLE "ScrapeSession" ADD COLUMN "phase" TEXT;
