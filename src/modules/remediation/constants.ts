import { ExecutionStatus, OsFamily, ScriptRuntime } from "@/generated/prisma/enums";

/** Client-safe: no Node builtins, no database access — usable from "use client" components. */

export const SCRIPT_RUNTIMES: readonly ScriptRuntime[] = [ScriptRuntime.BASH, ScriptRuntime.POWERSHELL, ScriptRuntime.PYTHON];
export const OS_FAMILIES: readonly OsFamily[] = Object.values(OsFamily);

/** Host-side policies an agent reports from its LOCAL configuration (agent/README.md "Remediation"). */
export const REMEDIATION_MODES = ["disabled", "allowlist", "any"] as const;
export type RemediationMode = (typeof REMEDIATION_MODES)[number];

/** Statuses in which an execution is still going somewhere (blocks duplicates, counts for cooldowns). */
export const LIVE_STATUSES: readonly ExecutionStatus[] = [ExecutionStatus.AWAITING_APPROVAL, ExecutionStatus.PENDING, ExecutionStatus.RUNNING];

/**
 * Why an execution was skipped, cancelled or failed without a script result — stored in
 * RemediationExecution.statusReason and translated by the UI (`remediation.reason.*`).
 */
export const STATUS_REASONS = [
  // decided by the platform
  "action_disabled",
  "no_target_host",
  "host_disabled",
  "host_not_accepting",
  "not_in_allowlist",
  "os_not_allowed",
  "already_queued",
  "cooldown",
  "rate_limited",
  "cancelled",
  "expired",
  "agent_lost",
  // reported by the agent
  "refused_by_agent_policy",
  "unsupported_runtime",
  "interpreter_not_found",
  "start_failed",
] as const;
export type StatusReason = (typeof STATUS_REASONS)[number];

export const MAX_SCRIPT_BYTES = 64 * 1024;
export const MAX_OUTPUT_BYTES = 64 * 1024;
export const MAX_ARGS = 20;
/** Argument names become environment variables IKELYANE_ARG_<NAME>. */
export const ARG_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
