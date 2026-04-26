-- AlterTable
ALTER TABLE "RawPost" ADD COLUMN "processedAt" DATETIME;

-- CreateIndex
CREATE INDEX "RawPost_processedAt_idx" ON "RawPost"("processedAt");

-- Backfill: any RawPost that already has a Signal has necessarily been
-- evaluated by the signals stage, so mark it processed now to prevent
-- Claude from re-evaluating (and re-emitting duplicate signals).
UPDATE "RawPost"
SET "processedAt" = CURRENT_TIMESTAMP
WHERE "id" IN (SELECT DISTINCT "rawPostId" FROM "Signal");
