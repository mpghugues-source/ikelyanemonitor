/**
 * Register a monitored host and print its agent credentials.
 *
 *   DATABASE_URL=… IKELYANE_SECRET_KEY=… npm run provision:host -- --org acme --hostname web-01
 *   options: --org <slug> (created if missing)  --hostname <name>  [--display "Web 01"]
 *
 * The HMAC secret is printed ONCE, here. Only its AES-256-GCM ciphertext is stored: it cannot be
 * recovered later, only rotated. (A UI for this arrives with the dashboard; until then this script
 * is the way to onboard an agent.)
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { PrismaClient } from "../src/generated/prisma/client";
import { encryptSecret, generateAgentCredentials, hostSecretAad } from "../src/lib/crypto";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const orgSlug = arg("org");
  const hostname = arg("hostname");
  if (!orgSlug || !hostname) {
    console.error("Usage: npm run provision:host -- --org <slug> --hostname <name> [--display <label>]");
    process.exit(2);
  }
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(orgSlug)) {
    console.error("--org must be a slug: lower-case letters, digits and dashes (2–63 characters).");
    process.exit(2);
  }
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is required.");
    process.exit(2);
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const db = new PrismaClient({ adapter: new PrismaPg(pool) });

  try {
    const org = await db.organization.upsert({
      where: { slug: orgSlug },
      create: { slug: orgSlug, name: orgSlug },
      update: {},
    });

    const { keyId, secret } = generateAgentCredentials();
    const host = await db.monitoredHost.create({
      data: {
        orgId: org.id,
        hostname,
        displayName: arg("display"),
        keyId,
        hmacSecretEnc: encryptSecret(secret, hostSecretAad(keyId)),
      },
      select: { id: true },
    });

    console.log(`Host registered (id ${host.id}) in organization "${org.slug}".\n`);
    console.log("Give these to the agent — the secret will NOT be shown again:\n");
    console.log(`  X-Ikelyane-Key-Id : ${keyId}`);
    console.log(`  HMAC secret       : ${secret}\n`);
    console.log("Signing protocol: docs/telemetry.md");
  } catch (error) {
    if (error instanceof Error && error.message.includes("Unique constraint")) {
      console.error(`A host named "${hostname}" already exists in organization "${orgSlug}".`);
      process.exit(1);
    }
    throw error;
  } finally {
    await db.$disconnect();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
