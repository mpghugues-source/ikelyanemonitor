-- Integrity rules that Prisma's schema language cannot express.
-- They are the last line of defence: the application validates first (Zod), the database refuses
-- whatever slips through.

-- A metric value must be a real, finite number (rejects NaN and ±Infinity: x - x = 0 only for finite x).
ALTER TABLE metric_entries
  ADD CONSTRAINT metric_entries_value_finite CHECK (("value" - "value") = 0);

-- Topology: no self-loops.
ALTER TABLE service_dependencies
  ADD CONSTRAINT service_dependencies_no_self_loop CHECK ("parentNodeId" <> "childNodeId");

-- Alert rules: a static threshold needs BOTH operator and threshold; otherwise anomaly detection
-- must be on. A rule with neither could never fire.
ALTER TABLE alert_rules
  ADD CONSTRAINT alert_rules_condition_defined CHECK (
    ("operator" IS NOT NULL AND "threshold" IS NOT NULL) OR "anomalyDetection"
  ),
  ADD CONSTRAINT alert_rules_duration_positive CHECK ("durationSec" >= 0 AND "cooldownSec" >= 0);

-- Ratios and percentages stay in their documented range.
ALTER TABLE database_instances
  ADD CONSTRAINT database_instances_cache_hit_ratio CHECK ("cacheHitRatio" IS NULL OR ("cacheHitRatio" BETWEEN 0 AND 1));

ALTER TABLE network_interfaces
  ADD CONSTRAINT network_interfaces_utilization CHECK ("utilizationPercent" IS NULL OR ("utilizationPercent" BETWEEN 0 AND 100)),
  ADD CONSTRAINT network_interfaces_packet_loss CHECK ("packetLossPercent" IS NULL OR ("packetLossPercent" BETWEEN 0 AND 100));

ALTER TABLE incidents
  ADD CONSTRAINT incidents_scores_range CHECK (
    ("anomalyScore" IS NULL OR "anomalyScore" BETWEEN 0 AND 1)
    AND ("rcaConfidence" IS NULL OR "rcaConfidence" BETWEEN 0 AND 1)
  );

ALTER TABLE finops_recommendations
  ADD CONSTRAINT finops_recommendations_confidence CHECK ("confidence" IS NULL OR "confidence" BETWEEN 0 AND 1);

-- Endpoint checks: sane scheduling and SLA bounds.
ALTER TABLE endpoint_checks
  ADD CONSTRAINT endpoint_checks_interval CHECK ("intervalSec" >= 10),
  ADD CONSTRAINT endpoint_checks_timeout CHECK ("timeoutMs" BETWEEN 100 AND 120000),
  ADD CONSTRAINT endpoint_checks_sla CHECK ("slaTargetPercent" BETWEEN 0 AND 100);

-- Organizations: retention window and GreenOps factors.
ALTER TABLE organizations
  ADD CONSTRAINT organizations_retention CHECK ("retentionDays" BETWEEN 1 AND 3650),
  ADD CONSTRAINT organizations_pue CHECK ("powerUsageEffectiveness" >= 1),
  ADD CONSTRAINT organizations_carbon CHECK ("carbonIntensityGco2PerKwh" >= 0);
