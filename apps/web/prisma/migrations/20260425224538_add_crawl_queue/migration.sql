-- CreateTable
CREATE TABLE "CrawlJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "kind" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "leaseUntil" DATETIME,
    "enqueuedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "error" TEXT,
    "errorReason" TEXT,
    "itemsCaptured" INTEGER,
    "expandToDetail" BOOLEAN NOT NULL DEFAULT true,
    "parentId" TEXT,
    CONSTRAINT "CrawlJob_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "CrawlJob" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CrawlConfig" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'singleton',
    "paused" BOOLEAN NOT NULL DEFAULT false,
    "pauseReason" TEXT,
    "throttleMinMs" INTEGER NOT NULL DEFAULT 5000,
    "throttleMaxMs" INTEGER NOT NULL DEFAULT 9000,
    "expandToDetail" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "CrawlJob_status_enqueuedAt_idx" ON "CrawlJob"("status", "enqueuedAt");

-- CreateIndex
CREATE INDEX "CrawlJob_leaseUntil_idx" ON "CrawlJob"("leaseUntil");

-- CreateIndex
CREATE INDEX "CrawlJob_parentId_idx" ON "CrawlJob"("parentId");
