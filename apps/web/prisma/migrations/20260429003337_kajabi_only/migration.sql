-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Opportunity" (
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
    "bstockSpecificity" REAL NOT NULL DEFAULT 0,
    "estMrrCeiling" INTEGER,
    "estCacBand" TEXT,
    "notes" TEXT,
    "centroid" BLOB,
    "researchedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Opportunity" ("centroid", "competitionScore", "createdAt", "demandScore", "estCacBand", "estMrrCeiling", "id", "monetizationScore", "niche", "notes", "oneLiner", "researchedAt", "score", "soloDevScore", "status", "title", "updatedAt") SELECT "centroid", "competitionScore", "createdAt", "demandScore", "estCacBand", "estMrrCeiling", "id", "monetizationScore", "niche", "notes", "oneLiner", "researchedAt", "score", "soloDevScore", "status", "title", "updatedAt" FROM "Opportunity";
DROP TABLE "Opportunity";
ALTER TABLE "new_Opportunity" RENAME TO "Opportunity";
CREATE INDEX "Opportunity_status_score_idx" ON "Opportunity"("status", "score");
CREATE INDEX "Opportunity_niche_idx" ON "Opportunity"("niche");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
