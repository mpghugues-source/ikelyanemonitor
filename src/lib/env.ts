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
