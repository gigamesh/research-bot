-- AlterTable
ALTER TABLE "CrawlJob" ADD COLUMN "preset" TEXT;

-- CreateIndex
CREATE INDEX "CrawlJob_preset_idx" ON "CrawlJob"("preset");
