import "dotenv/config";
import path from "node:path";
import { defineConfig } from "prisma/config";

const dbUrl = process.env.DATABASE_URL ?? "file:./prisma/dev.db";
const filename = dbUrl.startsWith("file:")
  ? path.resolve(process.cwd(), dbUrl.slice("file:".length))
  : dbUrl;

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: `file:${filename}`,
  },
});
