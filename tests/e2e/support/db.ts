import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { hashPassword } from "../../../src/lib/auth/password";

/**
 * Database access and fixtures for the browser tests.
 *
 * Plain `pg` + SQL rather than the generated Prisma client: Playwright compiles test code to
 * CommonJS, which cannot load the ESM-only generated client. Fixtures are inserted directly (with a
 * pre-computed password hash — scrypt is deliberately slow) so each test starts from a known state
 * without clicking through set-up screens.
 */

export const PASSWORD = "e2e-Correct-Horse-Battery-9";

export type Role = "OWNER" | "ADMIN" | "OPERATOR" | "VIEWER";

const runId = randomBytes(3).toString("hex");
export const domain = `${runId}.e2e.test`;

let pool: Pool | undefined;
let passwordHash: string | undefined;
let counter = 0;

function getPool(): Pool {
  pool ??= new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
  return pool;
}

/** Run a query and return its rows (for set-up and for asserting what the app stored). */
export async function query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await getPool().query(sql, params)).rows as T[];
}

export interface TestUser {
  id: string;
  email: string;
  name: string;
  role: Role;
}

export interface TestOrg {
  id: string;
  name: string;
  owner: TestUser;
  admin: TestUser;
  operator: TestUser;
  viewer: TestUser;
}

export async function makeUser(label: string, locale: "EN" | "FR" = "EN"): Promise<Omit<TestUser, "role">> {
  passwordHash ??= await hashPassword(PASSWORD);
  const id = randomUUID();
  const email = `${label}-${++counter}@${domain}`;
  const name = `${label[0].toUpperCase()}${label.slice(1)} Tester`;
  await query(
    `INSERT INTO users (id, email, name, "passwordHash", locale, "updatedAt") VALUES ($1, $2, $3, $4, $5::"Locale", now())`,
    [id, email, name, passwordHash, locale],
  );
  return { id, email, name };
}

/** An organization with one user per role, all sharing PASSWORD. */
export async function makeOrg(label: string): Promise<TestOrg> {
  const id = randomUUID();
  const name = `${label} ${runId}`;
  await query(`INSERT INTO organizations (id, name, slug, "updatedAt") VALUES ($1, $2, $3, now())`, [id, name, `${label}-${runId}-${++counter}`]);

  const users = {} as Record<Role, TestUser>;
  for (const role of ["OWNER", "ADMIN", "OPERATOR", "VIEWER"] as Role[]) {
    const user = await makeUser(`${label}-${role.toLowerCase()}`);
    await addMember(id, user, role);
    users[role] = { ...user, role };
  }
  return { id, name, owner: users.OWNER, admin: users.ADMIN, operator: users.OPERATOR, viewer: users.VIEWER };
}

export async function addMember(orgId: string, user: { id: string }, role: Role): Promise<void> {
  await query(`INSERT INTO memberships (id, "userId", "orgId", role) VALUES ($1, $2, $3, $4::"Role")`, [randomUUID(), user.id, orgId, role]);
}

export async function setMemberRole(orgId: string, userId: string, role: Role): Promise<void> {
  await query(`UPDATE memberships SET role = $3::"Role" WHERE "orgId" = $1 AND "userId" = $2`, [orgId, userId, role]);
}

/**
 * Remove everything created by this run — including rows made THROUGH the app (accepted invitations,
 * hosts, audit entries) and rows without a foreign key (metrics, audit trail, login attempts).
 * An organization belongs to the run if its slug carries the run id or one of the run's users is a member.
 */
export async function cleanup(): Promise<void> {
  if (!pool) return;
  const like = `%@${domain}`;
  const orgIds = (
    await query<{ id: string }>(
      `SELECT id FROM organizations WHERE slug LIKE $2
       UNION SELECT m."orgId" FROM memberships m JOIN users u ON u.id = m."userId" WHERE u.email LIKE $1`,
      [like, `%-${runId}-%`],
    )
  ).map((row) => row.id);

  if (orgIds.length > 0) {
    await query(`DELETE FROM metric_entries WHERE "orgId" = ANY($1)`, [orgIds]);
    await query(`DELETE FROM audit_logs WHERE "orgId" = ANY($1)`, [orgIds]);
  }
  await query(`DELETE FROM audit_logs WHERE "actorEmail" LIKE $1`, [like]);
  await query(`DELETE FROM login_attempts WHERE email LIKE $1`, [like]);
  if (orgIds.length > 0) await query(`DELETE FROM organizations WHERE id = ANY($1)`, [orgIds]);
  await query(`DELETE FROM users WHERE email LIKE $1`, [like]);
  await pool.end();
  pool = undefined;
}
