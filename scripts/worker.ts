/**
 * Background worker — everything that must not run inside a web request:
 *   • the synthetic check runner (probes the endpoints of the SaaS page);
 *   • the optional Claude narratives for root-cause analyses (only when ANTHROPIC_API_KEY is set).
 *
 *   DATABASE_URL=… IKELYANE_SECRET_KEY=… npm run worker
 *
 * Long-running; stop with SIGINT/SIGTERM (in-flight work finishes and is stored first). Several
 * instances may run side by side: every unit of work is claimed by exactly one of them. See
 * src/lib/env.ts for CHECK_RUNNER_CONCURRENCY, CHECKS_ALLOW_PRIVATE_TARGETS, AIOPS_LLM_MAX_PER_HOUR.
 */
import { getEnv } from "@/lib/env";
import { getPrisma } from "@/lib/prisma";
import { llmEnabled } from "@/modules/aiops/rca";
import { defaultDeps, runNarrativeLoop } from "@/modules/aiops/rca-llm";
import { runCheckLoop } from "@/modules/saas/runner/runner";

async function main(): Promise<void> {
  const env = getEnv();
  const db = getPrisma();
  const controller = new AbortController();
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      console.log(`[worker] ${signal} received, finishing in-flight work…`);
      controller.abort();
    });
  }

  console.log(
    `[worker] started: checks concurrency=${env.CHECK_RUNNER_CONCURRENCY}` +
      (env.CHECKS_ALLOW_PRIVATE_TARGETS ? " — WARNING: private/loopback check targets ALLOWED" : ""),
  );
  const loops = [
    runCheckLoop(db, {
      concurrency: env.CHECK_RUNNER_CONCURRENCY,
      tickMs: 2000,
      signal: controller.signal,
      allowPrivateTargets: env.CHECKS_ALLOW_PRIVATE_TARGETS,
    }),
  ];
  if (llmEnabled()) {
    const deps = defaultDeps();
    console.log(`[worker] Claude RCA narratives enabled: model=${deps.model}, at most ${env.AIOPS_LLM_MAX_PER_HOUR}/hour`);
    loops.push(runNarrativeLoop(db, { signal: controller.signal, tickMs: 5000, maxPerHour: env.AIOPS_LLM_MAX_PER_HOUR, deps }));
  } else {
    console.log("[worker] Claude RCA narratives disabled (ANTHROPIC_API_KEY not set): deterministic RCA only");
  }

  await Promise.all(loops);
  await db.$disconnect();
  console.log("[worker] stopped");
}

main().catch((error) => {
  console.error("[worker] fatal", error);
  process.exit(1);
});
