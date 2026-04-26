-- CreateTable
CREATE TABLE "Source" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "config" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "RawPost" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sourceId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "author" TEXT,
    "postedAt" DATETIME,
    "title" TEXT,
    "body" TEXT NOT NULL,
    "rawJson" TEXT,
    "fetchedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RawPost_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "Source" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Signal" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "rawPostId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "nicheTags" TEXT NOT NULL,
    "embedding" BLOB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Signal_rawPostId_fkey" FOREIGN KEY ("rawPostId") REFERENCES "RawPost" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Opportunity" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "oneLiner" TEXT NOT NULL,
    "niche" TEXT,
    "status" TEXT NOT NULL DEFAULT 'candidate',
    "score" REAL NOT NULL DEFAULT 0,
    "soloDevScore" REAL NOT NULL DEFAULT 0,
    "demandScore" REAL NOT NULL DEFAULT 0,
    "monetizationScore" REAL NOT NULL DEFAULT 0,
    "competitionScore" REAL NOT NULL DEFAULT 0,
    "estMrrCeiling" INTEGER,
    "estCacBand" TEXT,
    "notes" TEXT,
    "centroid" BLOB,
    "researchedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Evidence" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "opportunityId" TEXT NOT NULL,
    "signalId" TEXT NOT NULL,
    "weight" REAL NOT NULL DEFAULT 1.0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Evidence_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Evidence_signalId_fkey" FOREIGN KEY ("signalId") REFERENCES "Signal" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Job" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "kind" TEXT NOT NULL,
    "payload" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" DATETIME,
    "finishedAt" DATETIME
);

-- CreateIndex
CREATE UNIQUE INDEX "Source_name_key" ON "Source"("name");

-- CreateIndex
CREATE INDEX "RawPost_fetchedAt_idx" ON "RawPost"("fetchedAt");

-- CreateIndex
CREATE UNIQUE INDEX "RawPost_sourceId_externalId_key" ON "RawPost"("sourceId", "externalId");

-- CreateIndex
CREATE INDEX "Signal_rawPostId_idx" ON "Signal"("rawPostId");

-- CreateIndex
CREATE INDEX "Signal_createdAt_idx" ON "Signal"("createdAt");

-- CreateIndex
CREATE INDEX "Opportunity_status_score_idx" ON "Opportunity"("status", "score");

-- CreateIndex
CREATE INDEX "Opportunity_niche_idx" ON "Opportunity"("niche");

-- CreateIndex
CREATE INDEX "Evidence_signalId_idx" ON "Evidence"("signalId");

-- CreateIndex
CREATE UNIQUE INDEX "Evidence_opportunityId_signalId_key" ON "Evidence"("opportunityId", "signalId");

-- CreateIndex
CREATE INDEX "Job_kind_status_idx" ON "Job"("kind", "status");

-- CreateIndex
CREATE INDEX "Job_createdAt_idx" ON "Job"("createdAt");
