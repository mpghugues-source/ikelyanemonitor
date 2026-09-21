/**
 * Create the FIRST account of an installation: an organization and its OWNER.
 *
 *   DATABASE_URL=… npm run create:owner -- --email you@example.com --name "Your Name" --org "Acme"
 *
 * Self-service sign-up is off by default and everyone else joins by invitation, so a fresh install
 * has nobody who could invite. This command needs shell access to the server — that is the point:
 * it cannot be triggered remotely, unlike a "first visitor becomes admin" web page (which whoever
 * finds a new server first would win).
 *
 * A random initial password is generated and printed ONCE (never pass a password on the command
 * line: it would be visible in the process list and shell history). Change it after first sign-in.
 */
import { randomBytes } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { PrismaClient } from "../src/generated/prisma/client";
import { createOrganization, createUser } from "../src/lib/auth/users";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const email = arg("email");
  const name = arg("name");
  const organization = arg("org");
  if (!email || !organization) {
    console.error('Usage: npm run create:owner -- --email <email> --org "<organization name>" [--name "<full name>"] [--locale en|fr]');
    process.exit(2);
  }
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is required.");
    process.exit(2);
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const db = new PrismaClient({ adapter: new PrismaPg(pool) });

  try {
    const password = randomBytes(18).toString("base64url"); // 24 characters, 144 bits
    const user = await createUser(db, { email, name, password, locale: arg("locale") === "fr" ? "FR" : "EN" });
    if (!user.ok) {
      console.error(
        user.error === "email_taken"
          ? `An account already exists for ${email}. To add someone to an organization, invite them from Settings → Members.`
          : `Could not create the account: ${user.error}`,
      );
      process.exit(1);
    }

    const org = await createOrganization(db, { name: organization, ownerUserId: user.value.id, ownerEmail: user.value.email });

    console.log(`Organization "${organization}" created (slug ${org.slug}).`);
    console.log(`Owner account: ${user.value.email}\n`);
    console.log("Initial password — shown ONCE, change it after your first sign-in:\n");
    console.log(`  ${password}\n`);
  } finally {
    await db.$disconnect();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
