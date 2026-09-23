/**
 * Synthetic check runner — probes the HTTP(S) endpoints configured on the SaaS page.
 *
 *   DATABASE_URL=… IKELYANE_SECRET_KEY=… npm run checks:runner
 *
 * Long-running; stop with SIGINT/SIGTERM (in-flight probes finish and are stored first). Several
 * instances may run side by side: each due check is claimed by exactly one of them. Configuration:
 * CHECK_RUNNER_CONCURRENCY (default 20), CHECKS_ALLOW_PRIVATE_TARGETS (default false) — see src/lib/env.ts.
 */
import { getEnv } from "@/lib/env";
import { getPrisma } from "@/lib/prisma";
import { runCheckLoop } from "@/modules/saas/runner/runner";

async function main(): Promise<void> {
  const env = getEnv();
  const db = getPrisma();
  const controller = new AbortController();
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      console.log(`[checks] ${signal} received, finishing in-flight checks…`);
      controller.abort();
    });
  }

  console.log(
    `[checks] runner started: concurrency=${env.CHECK_RUNNER_CONCURRENCY}` +
      (env.CHECKS_ALLOW_PRIVATE_TARGETS ? " — WARNING: private/loopback targets ALLOWED" : ""),
  );
  await runCheckLoop(db, {
    concurrency: env.CHECK_RUNNER_CONCURRENCY,
    tickMs: 2000,
    signal: controller.signal,
    allowPrivateTargets: env.CHECKS_ALLOW_PRIVATE_TARGETS,
  });
  await db.$disconnect();
  console.log("[checks] stopped");
}

main().catch((error) => {
  console.error("[checks] fatal", error);
  process.exit(1);
});
