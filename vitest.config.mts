import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // Next.js handles the `server-only` marker itself; under Vitest it must be a no-op.
      "server-only": fileURLToPath(new URL("./tests/stubs/server-only.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Password hashing is deliberately slow (~0.3 s per scrypt): scenarios that sign in a dozen
    // times need more than Vitest's 5 s default.
    testTimeout: 30_000,
    // next-intl imports "next/server" without a file extension, which native Node ESM refuses:
    // let Vite process it so the proxy can be unit-tested.
    server: { deps: { inline: ["next-intl"] } },
    // Integration tests (tests/integration) need a real PostgreSQL + TimescaleDB and are enabled
    // by setting DATABASE_URL; they are skipped otherwise (see tests/integration/*).
  },
});
