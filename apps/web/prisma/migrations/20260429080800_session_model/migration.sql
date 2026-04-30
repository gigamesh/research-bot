-- Drop the old crawl-queue tables; replace with a single ScrapeSession row.
PRAGMA foreign_keys=OFF;

DROP TABLE IF EXISTS "CrawlJob";
DROP TABLE IF EXISTS "CrawlConfig";

CREATE TABLE "ScrapeSession" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'singleton',
    "status" TEXT NOT NULL DEFAULT 'idle',
    "kind" TEXT NOT NULL DEFAULT 'feed',
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "lastHeartbeat" DATETIME,
    "failReason" TEXT,
    "errorMessage" TEXT,
    "updatedAt" DATETIME NOT NULL
);

PRAGMA foreign_keys=ON;
