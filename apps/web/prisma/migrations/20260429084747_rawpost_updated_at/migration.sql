-- SQLite can't add a NOT NULL column with a non-constant default.
-- Workaround: add with a fixed epoch default, then backfill from fetchedAt
-- so the column is meaningfully populated for existing rows.
ALTER TABLE "RawPost" ADD COLUMN "updatedAt" DATETIME NOT NULL DEFAULT '1970-01-01 00:00:00';
UPDATE "RawPost" SET "updatedAt" = "fetchedAt" WHERE "updatedAt" = '1970-01-01 00:00:00';
