-- AIOps: structured root-cause findings and the optional Claude narrative queue.
ALTER TABLE "incidents" ADD COLUMN "rcaFindings" JSONB,
ADD COLUMN "rcaLlmAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "rcaLlmError" TEXT,
ADD COLUMN "rcaLlmRequestedAt" TIMESTAMP(3);

CREATE INDEX "incidents_rcaLlmRequestedAt_idx" ON "incidents"("rcaLlmRequestedAt");

