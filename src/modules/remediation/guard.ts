import type { ExecutionStatus, OsFamily } from "@/generated/prisma/enums";
import { LIVE_STATUSES, type StatusReason } from "@/modules/remediation/constants";

/**
 * Safety guard-rails applied before an execution is queued — pure, see tests/remediation.test.ts.
 * The agent applies its own, independent local policy on top (it never trusts the platform alone).
 */

export interface GuardAction {
  enabled: boolean;
  allowedOsFamilies: readonly OsFamily[];
  cooldownSec: number;
  maxRunsPerHour: number;
}

export interface GuardHost {
  enabled: boolean;
  osFamily: OsFamily | null;
  /** From the agent's local config; null = never reported (old agent) = not accepting. */
  remediationMode: string | null;
  remediationAllowlist: readonly string[];
}

export interface RecentExecution {
  status: ExecutionStatus;
  createdAt: Date;
}

export function guardrailViolation(
  action: GuardAction,
  host: GuardHost,
  scriptSha256: string,
  recent: readonly RecentExecution[],
  now: Date,
): StatusReason | null {
  if (!action.enabled) return "action_disabled";
  if (!host.enabled) return "host_disabled";
  if (host.remediationMode !== "allowlist" && host.remediationMode !== "any") return "host_not_accepting";
  if (host.remediationMode === "allowlist" && !host.remediationAllowlist.includes(scriptSha256)) return "not_in_allowlist";
  if (action.allowedOsFamilies.length > 0 && (host.osFamily === null || !action.allowedOsFamilies.includes(host.osFamily))) return "os_not_allowed";

  const counted = recent.filter((e) => e.status !== "SKIPPED" && e.status !== "CANCELLED");
  if (counted.some((e) => LIVE_STATUSES.includes(e.status))) return "already_queued";
  const t = now.getTime();
  if (counted.some((e) => t - e.createdAt.getTime() < action.cooldownSec * 1000)) return "cooldown";
  if (counted.filter((e) => t - e.createdAt.getTime() < 3600_000).length >= action.maxRunsPerHour) return "rate_limited";
  return null;
}
