// Prisma 7: the connection URL lives here, not in schema.prisma.
// `dotenv/config` loads a local .env when present; in production, real environment variables win.
import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: process.env["DATABASE_URL"],
  },
});
