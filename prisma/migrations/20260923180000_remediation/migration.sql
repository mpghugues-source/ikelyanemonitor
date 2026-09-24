-- Auto-remediation: frozen script snapshot per execution, and the host-side policy reported by agents.
-- AlterTable
ALTER TABLE "monitored_hosts" ADD COLUMN     "remediationAllowlist" TEXT[],
ADD COLUMN     "remediationMode" TEXT;

-- AlterTable
ALTER TABLE "remediation_executions" ADD COLUMN     "args" JSONB,
ADD COLUMN     "runtime" "ScriptRuntime" NOT NULL,
ADD COLUMN     "scriptBody" TEXT NOT NULL,
ADD COLUMN     "scriptSha256" TEXT NOT NULL,
ADD COLUMN     "statusReason" TEXT,
ADD COLUMN     "timeoutSec" INTEGER NOT NULL;

-- CreateIndex
CREATE INDEX "remediation_executions_hostId_status_createdAt_idx" ON "remediation_executions"("hostId", "status", "createdAt");


-- Guard-rails the application also enforces, kept true at the database level.
ALTER TABLE "remediation_actions"
  ADD CONSTRAINT remediation_actions_limits CHECK (
    "timeoutSec" BETWEEN 1 AND 3600 AND "cooldownSec" >= 0 AND "maxRunsPerHour" BETWEEN 1 AND 60
  );
ALTER TABLE "remediation_executions"
  ADD CONSTRAINT remediation_executions_snapshot CHECK (
    "timeoutSec" BETWEEN 1 AND 3600 AND "scriptSha256" ~ '^[0-9a-f]{64}$'
  );
ALTER TABLE "monitored_hosts"
  ADD CONSTRAINT monitored_hosts_remediation_mode CHECK (
    "remediationMode" IS NULL OR "remediationMode" IN ('disabled', 'allowlist', 'any')
  );
