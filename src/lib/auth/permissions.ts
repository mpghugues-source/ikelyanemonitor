import type { Role } from "@/generated/prisma/enums";

/**
 * Role-based access control — the single source of truth.
 *
 * Pure and dependency-free (only the Role TYPE is imported), so it can be used by server code to
 * ENFORCE and by client components to HIDE controls. Hiding is a convenience; enforcement always
 * happens on the server (see src/lib/auth/dal.ts).
 *
 * Roles form a strict hierarchy: each one has every permission of the one below it.
 *   VIEWER   read everything
 *   OPERATOR + acknowledge incidents, run remediations
 *   ADMIN    + configure monitoring, manage members (below ADMIN), rotate agent secrets, read the audit trail
 *   OWNER    + manage ADMIN/OWNER members, delete the organization
 */

export const PERMISSIONS = [
  // Read
  "hosts:read",
  "devices:read",
  "databases:read",
  "endpoints:read",
  "topology:read",
  "finops:read",
  "alerts:read",
  "incidents:read",
  "remediation:read",
  "members:read",
  // Operate
  "incidents:acknowledge",
  "remediation:run",
  /** Ask the check runner to probe an endpoint now — changes no configuration. */
  "endpoints:check",
  // Configure
  "hosts:write",
  "hosts:rotate-secret",
  "devices:write",
  "databases:write",
  "endpoints:write",
  "topology:write",
  "alerts:write",
  /** Editing scripts that agents execute is remote code execution: administrators only. */
  "remediation:write",
  // Administer
  "members:invite",
  "members:manage",
  "audit:read",
  "org:settings",
  // Own
  "members:manage-privileged",
  "org:delete",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const VIEWER: readonly Permission[] = [
  "hosts:read",
  "devices:read",
  "databases:read",
  "endpoints:read",
  "topology:read",
  "finops:read",
  "alerts:read",
  "incidents:read",
  "remediation:read",
  "members:read",
];

const OPERATOR: readonly Permission[] = [...VIEWER, "incidents:acknowledge", "remediation:run", "endpoints:check"];

const ADMIN: readonly Permission[] = [
  ...OPERATOR,
  "hosts:write",
  "hosts:rotate-secret",
  "devices:write",
  "databases:write",
  "endpoints:write",
  "topology:write",
  "alerts:write",
  "remediation:write",
  "members:invite",
  "members:manage",
  "audit:read",
  "org:settings",
];

const OWNER: readonly Permission[] = [...ADMIN, "members:manage-privileged", "org:delete"];

export const ROLE_PERMISSIONS: Readonly<Record<Role, ReadonlySet<Permission>>> = {
  VIEWER: new Set(VIEWER),
  OPERATOR: new Set(OPERATOR),
  ADMIN: new Set(ADMIN),
  OWNER: new Set(OWNER),
};

export const ROLES: readonly Role[] = ["OWNER", "ADMIN", "OPERATOR", "VIEWER"];

/** Higher = more privileged. */
export const ROLE_RANK: Readonly<Record<Role, number>> = { VIEWER: 0, OPERATOR: 1, ADMIN: 2, OWNER: 3 };

/** Does `role` grant `permission`? A missing role (not a member) grants nothing. */
export function can(role: Role | null | undefined, permission: Permission): boolean {
  return role ? ROLE_PERMISSIONS[role].has(permission) : false;
}

/**
 * Roles `actor` may hand out, either when inviting or when changing a member's role.
 * Nobody can grant a role above what they may manage themselves: an ADMIN cannot create another
 * ADMIN or an OWNER (that would let a compromised ADMIN account entrench itself).
 */
export function assignableRoles(actor: Role): Role[] {
  if (can(actor, "members:manage-privileged")) return ["OWNER", "ADMIN", "OPERATOR", "VIEWER"];
  if (can(actor, "members:manage")) return ["OPERATOR", "VIEWER"];
  return [];
}

/** May `actor` modify or remove a member who currently holds `targetRole`? (Not for oneself: see canLeave.) */
export function canManageMember(actor: Role, targetRole: Role): boolean {
  if (can(actor, "members:manage-privileged")) return true;
  return can(actor, "members:manage") && ROLE_RANK[targetRole] < ROLE_RANK.ADMIN;
}

/** May `actor` turn a member from `targetRole` into `newRole`? Both ends must be within reach. */
export function canChangeRole(actor: Role, targetRole: Role, newRole: Role): boolean {
  return canManageMember(actor, targetRole) && assignableRoles(actor).includes(newRole);
}
