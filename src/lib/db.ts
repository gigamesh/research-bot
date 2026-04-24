import "dotenv/config";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@/generated/prisma/client";

// Relative file: URLs are resolved against process.cwd() by better-sqlite3.
// Both `next dev` and `tsx scripts/...` run from the repo root, so this works
// identically in both contexts without any path manipulation.
const dbUrl = process.env.DATABASE_URL ?? "file:./prisma/dev.db";

type GlobalForPrisma = typeof globalThis & { __prisma?: PrismaClient };
const g = globalThis as GlobalForPrisma;

/// Prisma client singleton. In Next dev, HMR would otherwise spawn a new
/// instance on every reload; the global handle keeps us at one.
export const prisma: PrismaClient =
  g.__prisma ??
  new PrismaClient({
    adapter: new PrismaBetterSqlite3({ url: dbUrl }),
  });

if (process.env.NODE_ENV !== "production") g.__prisma = prisma;
