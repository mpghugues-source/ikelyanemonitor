import { describe, expect, it } from "vitest";
import type { Role } from "@/generated/prisma/enums";
import {
  assignableRoles,
  can,
  canChangeRole,
  canManageMember,
  PERMISSIONS,
  ROLE_PERMISSIONS,
  ROLE_RANK,
  ROLES,
  type Permission,
} from "@/lib/auth/permissions";

describe("permission matrix", () => {
  // The expected matrix is written out by hand, independently of the implementation, so that a
  // change of privilege is always a deliberate, reviewed edit of this table.
  const expected: Record<Role, Permission[]> = {
    VIEWER: [
      "hosts:read", "devices:read", "databases:read", "endpoints:read", "topology:read",
      "finops:read", "alerts:read", "incidents:read", "remediation:read", "members:read",
    ],
    OPERATOR: ["incidents:acknowledge", "remediation:run", "endpoints:check"],
    ADMIN: [
      "hosts:write", "hosts:rotate-secret", "devices:write", "databases:write", "endpoints:write",
      "topology:write", "alerts:write", "remediation:write", "members:invite", "members:manage",
      "audit:read", "org:settings",
    ],
    OWNER: ["members:manage-privileged", "org:delete"],
  };

  // Cumulative: each role also has everything below it.
  const cumulative = (role: Role): Set<Permission> => {
    const order: Role[] = ["VIEWER", "OPERATOR", "ADMIN", "OWNER"];
    return new Set(order.slice(0, order.indexOf(role) + 1).flatMap((r) => expected[r]));
  };

  it.each(ROLES)("%s has exactly the intended permissions", (role) => {
    expect(new Set(ROLE_PERMISSIONS[role])).toEqual(cumulative(role));
  });

  it("the table covers every permission that exists (none forgotten)", () => {
    const listed = new Set(Object.values(expected).flat());
    expect(new Set(PERMISSIONS)).toEqual(listed);
  });

  it("roles form a strict hierarchy", () => {
    expect(ROLE_RANK.VIEWER).toBeLessThan(ROLE_RANK.OPERATOR);
    expect(ROLE_RANK.OPERATOR).toBeLessThan(ROLE_RANK.ADMIN);
    expect(ROLE_RANK.ADMIN).toBeLessThan(ROLE_RANK.OWNER);
    for (const [lower, higher] of [["VIEWER", "OPERATOR"], ["OPERATOR", "ADMIN"], ["ADMIN", "OWNER"]] as [Role, Role][]) {
      for (const p of ROLE_PERMISSIONS[lower]) expect(ROLE_PERMISSIONS[higher].has(p)).toBe(true);
    }
  });

  it("a non-member (no role) has no permission at all", () => {
    for (const p of PERMISSIONS) {
      expect(can(null, p)).toBe(false);
      expect(can(undefined, p)).toBe(false);
    }
  });

  it("security-sensitive permissions are not held by lower roles", () => {
    // Editing remediation scripts = running code on hosts; secret rotation = agent takeover.
    for (const role of ["VIEWER", "OPERATOR"] as Role[]) {
      expect(can(role, "remediation:write")).toBe(false);
      expect(can(role, "hosts:rotate-secret")).toBe(false);
      expect(can(role, "members:invite")).toBe(false);
      expect(can(role, "audit:read")).toBe(false);
    }
    expect(can("ADMIN", "org:delete")).toBe(false);
    expect(can("ADMIN", "members:manage-privileged")).toBe(false);
  });
});

describe("who may hand out which role", () => {
  it("OWNER can assign every role; ADMIN only the two below it; others none", () => {
    expect(new Set(assignableRoles("OWNER"))).toEqual(new Set(["OWNER", "ADMIN", "OPERATOR", "VIEWER"]));
    expect(new Set(assignableRoles("ADMIN"))).toEqual(new Set(["OPERATOR", "VIEWER"]));
    expect(assignableRoles("OPERATOR")).toEqual([]);
    expect(assignableRoles("VIEWER")).toEqual([]);
  });

  it("an ADMIN can never create an ADMIN or OWNER (no self-entrenchment)", () => {
    expect(assignableRoles("ADMIN")).not.toContain("ADMIN");
    expect(assignableRoles("ADMIN")).not.toContain("OWNER");
  });

  it("managing members: OWNER anyone; ADMIN only OPERATOR/VIEWER; nobody below ADMIN", () => {
    for (const target of ROLES) expect(canManageMember("OWNER", target)).toBe(true);
    expect(canManageMember("ADMIN", "OPERATOR")).toBe(true);
    expect(canManageMember("ADMIN", "VIEWER")).toBe(true);
    expect(canManageMember("ADMIN", "ADMIN")).toBe(false);
    expect(canManageMember("ADMIN", "OWNER")).toBe(false);
    for (const actor of ["OPERATOR", "VIEWER"] as Role[]) {
      for (const target of ROLES) expect(canManageMember(actor, target)).toBe(false);
    }
  });

  it("changing a role needs reach over BOTH the current and the new role", () => {
    expect(canChangeRole("ADMIN", "VIEWER", "OPERATOR")).toBe(true);
    expect(canChangeRole("ADMIN", "VIEWER", "ADMIN")).toBe(false); // promotion above own reach
    expect(canChangeRole("ADMIN", "ADMIN", "VIEWER")).toBe(false); // demoting a peer
    expect(canChangeRole("ADMIN", "OWNER", "VIEWER")).toBe(false); // demoting the owner
    expect(canChangeRole("OWNER", "ADMIN", "VIEWER")).toBe(true);
    expect(canChangeRole("OWNER", "VIEWER", "OWNER")).toBe(true);
    expect(canChangeRole("OPERATOR", "VIEWER", "OPERATOR")).toBe(false);
  });
});
