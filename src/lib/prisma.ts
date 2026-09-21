import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { getEnv } from "@/lib/env";

declare global {
  var __ikelyanePool: Pool | undefined;
  var __ikelyanePrisma: PrismaClient | undefined;
}

/**
 * Process-wide Prisma client (Prisma 7 requires a driver adapter).
 *
 * Created lazily so that importing this module never opens a connection — `next build` and unit
 * tests stay side-effect free. In development the client is cached on `globalThis` to survive
 * hot reloads without leaking pools.
 */
export function getPrisma(): PrismaClient {
  if (globalThis.__ikelyanePrisma) return globalThis.__ikelyanePrisma;

  const pool = globalThis.__ikelyanePool ?? new Pool({ connectionString: getEnv().DATABASE_URL, max: 10 });
  const client = new PrismaClient({ adapter: new PrismaPg(pool) });

  // Cache in every environment: a serverless-style re-creation per request would exhaust connections.
  globalThis.__ikelyanePool = pool;
  globalThis.__ikelyanePrisma = client;
  return client;
}
