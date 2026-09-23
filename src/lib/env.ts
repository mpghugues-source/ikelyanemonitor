import { z } from "zod";

/**
 * Server-side configuration, validated once and lazily (at first use, not at import), so that
 * `next build` and unit tests do not require production secrets.
 *
 * Validation errors list the variable NAMES and rules only — never the values, which may be secrets.
 */
const envSchema = z.object({
  DATABASE_URL: z.string().min(1, "is required"),
  /** 32-byte AES-256 master key, base64-encoded. Encrypts agent HMAC secrets and SNMP credentials. */
  IKELYANE_SECRET_KEY: z
    .string()
    .refine((value) => Buffer.from(value, "base64").length === 32, "must be 32 bytes, base64-encoded"),
  /** Maximum difference between the agent's signed timestamp and server time (replay window). */
  TELEMETRY_MAX_CLOCK_SKEW_SECONDS: z.coerce.number().int().min(1).max(3600).default(300),
  /** Maximum size of a telemetry request body. */
  TELEMETRY_MAX_BODY_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .max(16 * 1024 * 1024)
    .default(1024 * 1024),
  /** How far in the past a data point may be (agents replay their buffer after an outage). */
  TELEMETRY_MAX_BACKFILL_DAYS: z.coerce.number().int().min(1).max(90).default(7),

  /**
   * Outgoing alert e-mail (src/lib/notify/email.ts). When unset, mail is handed to the local
   * `/usr/sbin/sendmail` (works out of the box on this cPanel host, which already rewrites/DKIM-signs
   * `@ikelyane.com` outgoing mail — see the deployment notes). Set SMTP_URL to use a real SMTP
   * relay instead (e.g. on a host with no local MTA): smtp://user:pass@host:587.
   */
  SMTP_URL: z.string().trim().min(1).optional(),
  ALERTS_EMAIL_FROM: z.string().trim().min(1).default("IkelyaneMonitor <noreply@ikelyane.com>"),

  /**
   * Synthetic check runner (scripts/worker.ts). By default checks may only reach PUBLIC
   * addresses — tenants must not be able to probe the platform's own network (see
   * src/modules/saas/runner/target-guard.ts). Set to "true" only on a single-tenant, self-hosted
   * install that deliberately monitors its own LAN.
   */
  CHECKS_ALLOW_PRIVATE_TARGETS: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  /** Probes a runner keeps in flight at once. */
  CHECK_RUNNER_CONCURRENCY: z.coerce.number().int().min(1).max(500).default(20),

  /**
   * AIOps root-cause narratives by Claude (src/modules/aiops/rca-llm.ts) are enabled by setting
   * ANTHROPIC_API_KEY (read by the Anthropic SDK itself, never by this app). Cost guard: Claude calls
   * per hour and per worker. AIOPS_LLM_MODEL overrides the model (default claude-opus-5).
   */
  AIOPS_LLM_MAX_PER_HOUR: z.coerce.number().int().min(1).max(10_000).default(60),
});

export type AppEnv = z.infer<typeof envSchema>;

let cached: AppEnv | undefined;

export function getEnv(): AppEnv {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid server configuration — ${problems}`);
  }
  cached = parsed.data;
  return cached;
}

/** Test helper: forget the cached configuration. */
export function resetEnvCache(): void {
  cached = undefined;
}
