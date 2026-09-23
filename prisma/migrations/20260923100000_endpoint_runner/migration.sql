-- Synthetic check runner (scripts/check-runner.ts): scheduling and last failure reason.
ALTER TABLE "endpoint_checks" ADD COLUMN "lastError" TEXT,
ADD COLUMN "lastErrorDetail" TEXT,
ADD COLUMN "nextRunAt" TIMESTAMP(3);

CREATE INDEX "endpoint_checks_enabled_nextRunAt_idx" ON "endpoint_checks"("enabled", "nextRunAt");
