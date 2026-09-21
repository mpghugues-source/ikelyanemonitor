import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import type { Role } from "@/generated/prisma/enums";

/** A client or a transaction: functions that only read/write rows accept either. */
export type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Who is performing an operation, ALWAYS derived server-side from the validated session — never
 * from request input. Every business function re-checks the permission it needs against `role`
 * (defense in depth: a bug in one caller cannot bypass RBAC) and scopes queries by `orgId`.
 */
export interface Actor {
  userId: string;
  email: string;
  orgId: string;
  role: Role;
  ip?: string | null;
}
