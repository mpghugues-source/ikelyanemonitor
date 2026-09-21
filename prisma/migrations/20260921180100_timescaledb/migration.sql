-- TimescaleDB setup for the time-series table `metric_entries`.
-- Prisma cannot express hypertables, so this migration is hand-written.
-- Requires a PostgreSQL server with the TimescaleDB extension available
-- (docker image timescale/timescaledb, Timescale Cloud, or the OS package).

CREATE EXTENSION IF NOT EXISTS timescaledb;

-- 1. Hypertable: 1-day chunks. An agent typically sends a few hundred points per minute per host,
--    so a chunk stays comfortably in memory-sized territory even for several thousand hosts.
--    (migrate_data lets this migration also run on a table that already holds rows.)
SELECT create_hypertable(
  'metric_entries',
  by_range('time', INTERVAL '1 day'),
  migrate_data => true,
  if_not_exists => true
);

-- 2. Columnstore compression. `segmentby` groups a series together, so that a query for one
--    (source, metric, instance) only decompresses that series; rows are ordered by time.
ALTER TABLE metric_entries SET (
  timescaledb.enable_columnstore = true,
  timescaledb.segmentby = '"sourceId", "metric", "instance"',
  timescaledb.orderby   = '"time" DESC'
);

-- Compress chunks once they are 7 days old (recent data stays row-based: fast inserts and
-- late-arriving points from agents that were offline).
CALL add_columnstore_policy('metric_entries', after => INTERVAL '7 days', if_not_exists => true);

-- 3. Retention: raw points are dropped after 90 days. Organization.retentionDays can only be
--    LOWER than this global bound (a scheduled job deletes earlier for orgs that ask for it).
SELECT add_retention_policy('metric_entries', INTERVAL '90 days', if_not_exists => true);

-- 4. Continuous aggregate: 5-minute rollups (avg/min/max/count). Long-range charts (7d, 30d,
--    90d) read this instead of raw points, and it outlives the raw retention window.
CREATE MATERIALIZED VIEW metric_entries_5m
WITH (timescaledb.continuous) AS
SELECT
  time_bucket(INTERVAL '5 minutes', "time") AS bucket,
  "orgId",
  "sourceKind",
  "sourceId",
  "metric",
  "instance",
  avg("value")  AS "avgValue",
  min("value")  AS "minValue",
  max("value")  AS "maxValue",
  count(*)      AS "samples"
FROM metric_entries
GROUP BY bucket, "orgId", "sourceKind", "sourceId", "metric", "instance"
WITH NO DATA;

CREATE INDEX metric_entries_5m_lookup_idx
  ON metric_entries_5m ("sourceId", "metric", "instance", bucket DESC);

-- Refresh every 5 minutes over a sliding window, so late points (up to 2 days) are still folded in.
SELECT add_continuous_aggregate_policy(
  'metric_entries_5m',
  start_offset      => INTERVAL '2 days',
  end_offset        => INTERVAL '10 minutes',
  schedule_interval => INTERVAL '5 minutes',
  if_not_exists     => true
);

-- Rollups are tiny: keep them 2 years.
SELECT add_retention_policy('metric_entries_5m', INTERVAL '730 days', if_not_exists => true);
