-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Locale" AS ENUM ('EN', 'FR');

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('OWNER', 'ADMIN', 'OPERATOR', 'VIEWER');

-- CreateEnum
CREATE TYPE "Plan" AS ENUM ('FREE', 'PRO', 'ENTERPRISE');

-- CreateEnum
CREATE TYPE "HealthStatus" AS ENUM ('UNKNOWN', 'UP', 'DEGRADED', 'DOWN', 'MAINTENANCE');

-- CreateEnum
CREATE TYPE "OsFamily" AS ENUM ('WINDOWS', 'LINUX', 'MACOS', 'UNIX', 'OTHER');

-- CreateEnum
CREATE TYPE "NetworkDeviceType" AS ENUM ('ROUTER', 'SWITCH', 'FIREWALL', 'AP', 'UPS', 'BMC', 'OTHER');

-- CreateEnum
CREATE TYPE "SnmpVersion" AS ENUM ('V1', 'V2C', 'V3');

-- CreateEnum
CREATE TYPE "SnmpSecurityLevel" AS ENUM ('NO_AUTH_NO_PRIV', 'AUTH_NO_PRIV', 'AUTH_PRIV');

-- CreateEnum
CREATE TYPE "SnmpAuthProtocol" AS ENUM ('MD5', 'SHA', 'SHA224', 'SHA256', 'SHA384', 'SHA512');

-- CreateEnum
CREATE TYPE "SnmpPrivProtocol" AS ENUM ('DES', 'AES', 'AES192', 'AES256');

-- CreateEnum
CREATE TYPE "OperStatus" AS ENUM ('UP', 'DOWN', 'TESTING', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "DatabaseEngine" AS ENUM ('POSTGRESQL', 'MYSQL', 'MARIADB', 'MONGODB', 'REDIS', 'MSSQL');

-- CreateEnum
CREATE TYPE "HttpMethod" AS ENUM ('GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS');

-- CreateEnum
CREATE TYPE "MetricSource" AS ENUM ('HOST', 'NETWORK_DEVICE', 'NETWORK_INTERFACE', 'DATABASE', 'ENDPOINT');

-- CreateEnum
CREATE TYPE "MetricType" AS ENUM ('CPU_USAGE_PERCENT', 'LOAD_AVERAGE_1M', 'MEMORY_USED_PERCENT', 'MEMORY_USED_BYTES', 'SWAP_USED_PERCENT', 'DISK_USED_PERCENT', 'DISK_USED_BYTES', 'DISK_READ_IOPS', 'DISK_WRITE_IOPS', 'DISK_READ_BPS', 'DISK_WRITE_BPS', 'NETWORK_IN_BPS', 'NETWORK_OUT_BPS', 'PROCESS_COUNT', 'UPTIME_SECONDS', 'TEMPERATURE_CELSIUS', 'POWER_WATTS', 'BANDWIDTH_IN_BPS', 'BANDWIDTH_OUT_BPS', 'BANDWIDTH_UTILIZATION_PERCENT', 'PACKET_LOSS_PERCENT', 'INTERFACE_ERRORS_PER_SEC', 'INTERFACE_CRC_ERRORS_PER_SEC', 'LATENCY_MS', 'DB_QPS', 'DB_ACTIVE_CONNECTIONS', 'DB_CONNECTION_USAGE_PERCENT', 'DB_CACHE_HIT_RATIO', 'DB_SLOW_QUERIES_PER_MIN', 'DB_DEADLOCKS_PER_MIN', 'DB_REPLICATION_LAG_SECONDS', 'DB_STORAGE_USED_BYTES', 'ENDPOINT_RESPONSE_MS', 'ENDPOINT_AVAILABLE', 'ENDPOINT_SSL_DAYS_LEFT');

-- CreateEnum
CREATE TYPE "AlertOperator" AS ENUM ('GT', 'GTE', 'LT', 'LTE', 'EQ', 'NEQ');

-- CreateEnum
CREATE TYPE "Severity" AS ENUM ('INFO', 'WARNING', 'CRITICAL');

-- CreateEnum
CREATE TYPE "AnomalySensitivity" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('EMAIL', 'SLACK', 'TEAMS', 'WEBHOOK', 'SMS', 'PUSH');

-- CreateEnum
CREATE TYPE "IncidentStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'RESOLVED');

-- CreateEnum
CREATE TYPE "IncidentEventType" AS ENUM ('OPENED', 'ACKNOWLEDGED', 'NOTE', 'NOTIFIED', 'REMEDIATION_STARTED', 'REMEDIATION_FINISHED', 'RCA_GENERATED', 'RESOLVED', 'REOPENED');

-- CreateEnum
CREATE TYPE "ScriptRuntime" AS ENUM ('BASH', 'POWERSHELL', 'PYTHON');

-- CreateEnum
CREATE TYPE "ExecutionStatus" AS ENUM ('PENDING', 'AWAITING_APPROVAL', 'RUNNING', 'SUCCEEDED', 'FAILED', 'TIMED_OUT', 'SKIPPED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ExecutionTrigger" AS ENUM ('ALERT', 'MANUAL', 'SCHEDULE');

-- CreateEnum
CREATE TYPE "TopologyNodeKind" AS ENUM ('HOST', 'NETWORK_DEVICE', 'DATABASE', 'ENDPOINT', 'SERVICE', 'EXTERNAL');

-- CreateEnum
CREATE TYPE "DependencyKind" AS ENUM ('DEPENDS_ON', 'HOSTED_ON', 'CONNECTED_TO', 'ROUTES_TO', 'REPLICATES_TO');

-- CreateEnum
CREATE TYPE "FinOpsRecommendationKind" AS ENUM ('IDLE_RESOURCE', 'OVERSIZED', 'UNDERUTILIZED_STORAGE', 'OFF_HOURS_SHUTDOWN');

-- CreateEnum
CREATE TYPE "RecommendationStatus" AS ENUM ('OPEN', 'APPLIED', 'DISMISSED');

-- CreateTable
CREATE TABLE "organizations" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "plan" "Plan" NOT NULL DEFAULT 'FREE',
    "retentionDays" INTEGER NOT NULL DEFAULT 90,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "energyPricePerKwh" DECIMAL(10,4),
    "carbonIntensityGco2PerKwh" DOUBLE PRECISION NOT NULL DEFAULT 400,
    "powerUsageEffectiveness" DOUBLE PRECISION NOT NULL DEFAULT 1.4,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "passwordHash" TEXT,
    "locale" "Locale" NOT NULL DEFAULT 'EN',
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memberships" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'VIEWER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "monitored_hosts" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "hostname" TEXT NOT NULL,
    "displayName" TEXT,
    "tags" TEXT[],
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "keyId" TEXT NOT NULL,
    "hmacSecretEnc" TEXT NOT NULL,
    "secretRotatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "previousHmacSecretEnc" TEXT,
    "previousSecretExpiresAt" TIMESTAMP(3),
    "osFamily" "OsFamily" NOT NULL DEFAULT 'OTHER',
    "osName" TEXT,
    "osVersion" TEXT,
    "kernelVersion" TEXT,
    "arch" TEXT,
    "cpuModel" TEXT,
    "cpuCores" INTEGER,
    "cpuThreads" INTEGER,
    "cpuFrequencyMhz" INTEGER,
    "memoryTotalBytes" BIGINT,
    "diskTotalBytes" BIGINT,
    "ipAddresses" TEXT[],
    "macAddress" TEXT,
    "virtualization" TEXT,
    "cloudProvider" TEXT,
    "cloudRegion" TEXT,
    "agentVersion" TEXT,
    "hourlyCost" DECIMAL(12,6),
    "powerIdleWatts" DOUBLE PRECISION,
    "powerMaxWatts" DOUBLE PRECISION,
    "status" "HealthStatus" NOT NULL DEFAULT 'UNKNOWN',
    "firstSeenAt" TIMESTAMP(3),
    "lastSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "monitored_hosts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "network_devices" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "ipAddress" INET NOT NULL,
    "type" "NetworkDeviceType" NOT NULL,
    "tags" TEXT[],
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "vendor" TEXT,
    "model" TEXT,
    "firmwareVersion" TEXT,
    "serialNumber" TEXT,
    "sysName" TEXT,
    "sysDescr" TEXT,
    "sysLocation" TEXT,
    "sysContact" TEXT,
    "uptimeSeconds" BIGINT,
    "powerWatts" DOUBLE PRECISION,
    "pollerHostId" TEXT,
    "pollIntervalSec" INTEGER NOT NULL DEFAULT 60,
    "snmpVersion" "SnmpVersion" NOT NULL DEFAULT 'V2C',
    "snmpPort" INTEGER NOT NULL DEFAULT 161,
    "snmpTimeoutMs" INTEGER NOT NULL DEFAULT 3000,
    "snmpRetries" INTEGER NOT NULL DEFAULT 1,
    "snmpCommunityEnc" TEXT,
    "snmpV3Username" TEXT,
    "snmpV3SecurityLevel" "SnmpSecurityLevel",
    "snmpV3AuthProtocol" "SnmpAuthProtocol",
    "snmpV3AuthKeyEnc" TEXT,
    "snmpV3PrivProtocol" "SnmpPrivProtocol",
    "snmpV3PrivKeyEnc" TEXT,
    "snmpV3ContextName" TEXT,
    "status" "HealthStatus" NOT NULL DEFAULT 'UNKNOWN',
    "lastPolledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "network_devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "network_interfaces" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "ifIndex" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "alias" TEXT,
    "description" TEXT,
    "macAddress" TEXT,
    "speedMbps" BIGINT,
    "mtu" INTEGER,
    "adminStatus" "OperStatus" NOT NULL DEFAULT 'UNKNOWN',
    "operStatus" "OperStatus" NOT NULL DEFAULT 'UNKNOWN',
    "inBps" BIGINT NOT NULL DEFAULT 0,
    "outBps" BIGINT NOT NULL DEFAULT 0,
    "utilizationPercent" DOUBLE PRECISION,
    "packetLossPercent" DOUBLE PRECISION,
    "inErrors" BIGINT NOT NULL DEFAULT 0,
    "outErrors" BIGINT NOT NULL DEFAULT 0,
    "crcErrors" BIGINT NOT NULL DEFAULT 0,
    "inDiscards" BIGINT NOT NULL DEFAULT 0,
    "outDiscards" BIGINT NOT NULL DEFAULT 0,
    "lastChangeAt" TIMESTAMP(3),
    "lastPolledAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "network_interfaces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "database_instances" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "hostId" TEXT,
    "name" TEXT NOT NULL,
    "engine" "DatabaseEngine" NOT NULL,
    "version" TEXT,
    "endpoint" TEXT,
    "isReplica" BOOLEAN NOT NULL DEFAULT false,
    "tags" TEXT[],
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "storageQuotaBytes" BIGINT,
    "storageUsedBytes" BIGINT,
    "maxConnections" INTEGER,
    "activeConnections" INTEGER,
    "cacheHitRatio" DOUBLE PRECISION,
    "deadlocksTotal" BIGINT,
    "replicationLagSeconds" DOUBLE PRECISION,
    "slowQueryThresholdMs" INTEGER NOT NULL DEFAULT 1000,
    "status" "HealthStatus" NOT NULL DEFAULT 'UNKNOWN',
    "lastPolledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "database_instances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "slow_query_logs" (
    "id" TEXT NOT NULL,
    "dbInstanceId" TEXT NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "queryText" TEXT,
    "durationMs" DOUBLE PRECISION NOT NULL,
    "calls" INTEGER NOT NULL DEFAULT 1,
    "rowsExamined" BIGINT,
    "rowsReturned" BIGINT,
    "databaseName" TEXT,
    "userName" TEXT,

    CONSTRAINT "slow_query_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "metric_entries" (
    "time" TIMESTAMPTZ(3) NOT NULL,
    "orgId" TEXT NOT NULL,
    "sourceKind" "MetricSource" NOT NULL,
    "sourceId" TEXT NOT NULL,
    "metric" "MetricType" NOT NULL,
    "instance" TEXT NOT NULL DEFAULT '',
    "value" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "metric_entries_pkey" PRIMARY KEY ("sourceId","metric","instance","time")
);

-- CreateTable
CREATE TABLE "endpoint_checks" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "method" "HttpMethod" NOT NULL DEFAULT 'GET',
    "headers" JSONB,
    "body" TEXT,
    "expectedStatus" INTEGER NOT NULL DEFAULT 200,
    "expectedBodyContains" TEXT,
    "syntheticScript" TEXT,
    "followRedirects" BOOLEAN NOT NULL DEFAULT true,
    "verifySsl" BOOLEAN NOT NULL DEFAULT true,
    "intervalSec" INTEGER NOT NULL DEFAULT 60,
    "timeoutMs" INTEGER NOT NULL DEFAULT 10000,
    "regions" TEXT[],
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "tags" TEXT[],
    "slaTargetPercent" DOUBLE PRECISION NOT NULL DEFAULT 99.9,
    "sslExpiresAt" TIMESTAMP(3),
    "sslIssuer" TEXT,
    "status" "HealthStatus" NOT NULL DEFAULT 'UNKNOWN',
    "lastCheckedAt" TIMESTAMP(3),
    "lastStatusCode" INTEGER,
    "lastResponseMs" DOUBLE PRECISION,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "endpoint_checks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "topology_nodes" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "kind" "TopologyNodeKind" NOT NULL,
    "refId" TEXT,
    "label" TEXT NOT NULL,
    "positionX" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "positionY" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "topology_nodes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_dependencies" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "parentNodeId" TEXT NOT NULL,
    "childNodeId" TEXT NOT NULL,
    "kind" "DependencyKind" NOT NULL DEFAULT 'DEPENDS_ON',
    "criticality" "Severity" NOT NULL DEFAULT 'WARNING',
    "label" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "service_dependencies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alert_rules" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "sourceKind" "MetricSource" NOT NULL,
    "sourceId" TEXT,
    "metric" "MetricType" NOT NULL,
    "instanceFilter" TEXT,
    "operator" "AlertOperator",
    "threshold" DOUBLE PRECISION,
    "durationSec" INTEGER NOT NULL DEFAULT 300,
    "severity" "Severity" NOT NULL DEFAULT 'WARNING',
    "anomalyDetection" BOOLEAN NOT NULL DEFAULT false,
    "anomalySensitivity" "AnomalySensitivity" NOT NULL DEFAULT 'MEDIUM',
    "channels" "NotificationChannel"[],
    "notifyEmails" TEXT[],
    "webhookUrl" TEXT,
    "cooldownSec" INTEGER NOT NULL DEFAULT 900,
    "remediationActionId" TEXT,
    "autoRemediate" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "alert_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "incidents" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "ruleId" TEXT,
    "title" TEXT NOT NULL,
    "severity" "Severity" NOT NULL,
    "status" "IncidentStatus" NOT NULL DEFAULT 'OPEN',
    "sourceKind" "MetricSource",
    "sourceId" TEXT,
    "sourceLabel" TEXT,
    "metric" "MetricType",
    "triggerValue" DOUBLE PRECISION,
    "peakValue" DOUBLE PRECISION,
    "anomalyScore" DOUBLE PRECISION,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledgedAt" TIMESTAMP(3),
    "acknowledgedBy" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolvedBy" TEXT,
    "resolutionNote" TEXT,
    "rcaSummaryEn" TEXT,
    "rcaSummaryFr" TEXT,
    "rcaConfidence" DOUBLE PRECISION,
    "rcaModel" TEXT,
    "rcaGeneratedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "incidents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "incident_events" (
    "id" TEXT NOT NULL,
    "incidentId" TEXT NOT NULL,
    "type" "IncidentEventType" NOT NULL,
    "message" TEXT,
    "actorId" TEXT,
    "data" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "incident_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "remediation_actions" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "runtime" "ScriptRuntime" NOT NULL,
    "scriptBody" TEXT NOT NULL,
    "args" JSONB,
    "timeoutSec" INTEGER NOT NULL DEFAULT 60,
    "targetHostId" TEXT,
    "allowedOsFamilies" "OsFamily"[],
    "requiresApproval" BOOLEAN NOT NULL DEFAULT true,
    "cooldownSec" INTEGER NOT NULL DEFAULT 300,
    "maxRunsPerHour" INTEGER NOT NULL DEFAULT 3,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "remediation_actions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "remediation_executions" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "actionId" TEXT NOT NULL,
    "incidentId" TEXT,
    "hostId" TEXT,
    "trigger" "ExecutionTrigger" NOT NULL,
    "status" "ExecutionStatus" NOT NULL DEFAULT 'PENDING',
    "requestedBy" TEXT,
    "approvedBy" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "exitCode" INTEGER,
    "stdout" TEXT,
    "stderr" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "remediation_executions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "finops_recommendations" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "hostId" TEXT,
    "kind" "FinOpsRecommendationKind" NOT NULL,
    "status" "RecommendationStatus" NOT NULL DEFAULT 'OPEN',
    "details" JSONB,
    "estimatedMonthlySavings" DECIMAL(12,2),
    "estimatedKwhSavedMonthly" DOUBLE PRECISION,
    "estimatedCo2SavedKgMonthly" DOUBLE PRECISION,
    "confidence" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "finops_recommendations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "organizations_slug_key" ON "organizations"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "memberships_orgId_role_idx" ON "memberships"("orgId", "role");

-- CreateIndex
CREATE UNIQUE INDEX "memberships_userId_orgId_key" ON "memberships"("userId", "orgId");

-- CreateIndex
CREATE UNIQUE INDEX "monitored_hosts_keyId_key" ON "monitored_hosts"("keyId");

-- CreateIndex
CREATE INDEX "monitored_hosts_orgId_status_idx" ON "monitored_hosts"("orgId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "monitored_hosts_orgId_hostname_key" ON "monitored_hosts"("orgId", "hostname");

-- CreateIndex
CREATE INDEX "network_devices_orgId_type_idx" ON "network_devices"("orgId", "type");

-- CreateIndex
CREATE INDEX "network_devices_orgId_status_idx" ON "network_devices"("orgId", "status");

-- CreateIndex
CREATE INDEX "network_devices_pollerHostId_idx" ON "network_devices"("pollerHostId");

-- CreateIndex
CREATE UNIQUE INDEX "network_devices_orgId_ipAddress_key" ON "network_devices"("orgId", "ipAddress");

-- CreateIndex
CREATE INDEX "network_interfaces_deviceId_operStatus_idx" ON "network_interfaces"("deviceId", "operStatus");

-- CreateIndex
CREATE UNIQUE INDEX "network_interfaces_deviceId_ifIndex_key" ON "network_interfaces"("deviceId", "ifIndex");

-- CreateIndex
CREATE INDEX "database_instances_orgId_engine_idx" ON "database_instances"("orgId", "engine");

-- CreateIndex
CREATE INDEX "database_instances_orgId_status_idx" ON "database_instances"("orgId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "database_instances_orgId_hostId_engine_name_key" ON "database_instances"("orgId", "hostId", "engine", "name");

-- CreateIndex
CREATE INDEX "slow_query_logs_dbInstanceId_capturedAt_idx" ON "slow_query_logs"("dbInstanceId", "capturedAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "slow_query_logs_dbInstanceId_fingerprint_capturedAt_key" ON "slow_query_logs"("dbInstanceId", "fingerprint", "capturedAt");

-- CreateIndex
CREATE INDEX "metric_entries_orgId_metric_time_idx" ON "metric_entries"("orgId", "metric", "time" DESC);

-- CreateIndex
CREATE INDEX "endpoint_checks_orgId_status_idx" ON "endpoint_checks"("orgId", "status");

-- CreateIndex
CREATE INDEX "endpoint_checks_orgId_enabled_idx" ON "endpoint_checks"("orgId", "enabled");

-- CreateIndex
CREATE INDEX "topology_nodes_orgId_idx" ON "topology_nodes"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "topology_nodes_orgId_kind_refId_key" ON "topology_nodes"("orgId", "kind", "refId");

-- CreateIndex
CREATE INDEX "service_dependencies_orgId_idx" ON "service_dependencies"("orgId");

-- CreateIndex
CREATE INDEX "service_dependencies_childNodeId_idx" ON "service_dependencies"("childNodeId");

-- CreateIndex
CREATE UNIQUE INDEX "service_dependencies_parentNodeId_childNodeId_kind_key" ON "service_dependencies"("parentNodeId", "childNodeId", "kind");

-- CreateIndex
CREATE INDEX "alert_rules_orgId_enabled_idx" ON "alert_rules"("orgId", "enabled");

-- CreateIndex
CREATE INDEX "alert_rules_orgId_sourceKind_metric_idx" ON "alert_rules"("orgId", "sourceKind", "metric");

-- CreateIndex
CREATE INDEX "incidents_orgId_status_startedAt_idx" ON "incidents"("orgId", "status", "startedAt" DESC);

-- CreateIndex
CREATE INDEX "incidents_orgId_sourceId_idx" ON "incidents"("orgId", "sourceId");

-- CreateIndex
CREATE INDEX "incidents_ruleId_idx" ON "incidents"("ruleId");

-- CreateIndex
CREATE INDEX "incident_events_incidentId_createdAt_idx" ON "incident_events"("incidentId", "createdAt");

-- CreateIndex
CREATE INDEX "remediation_actions_orgId_enabled_idx" ON "remediation_actions"("orgId", "enabled");

-- CreateIndex
CREATE INDEX "remediation_executions_orgId_createdAt_idx" ON "remediation_executions"("orgId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "remediation_executions_actionId_createdAt_idx" ON "remediation_executions"("actionId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "remediation_executions_incidentId_idx" ON "remediation_executions"("incidentId");

-- CreateIndex
CREATE INDEX "finops_recommendations_orgId_status_idx" ON "finops_recommendations"("orgId", "status");

-- CreateIndex
CREATE INDEX "finops_recommendations_hostId_idx" ON "finops_recommendations"("hostId");

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "monitored_hosts" ADD CONSTRAINT "monitored_hosts_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "network_devices" ADD CONSTRAINT "network_devices_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "network_devices" ADD CONSTRAINT "network_devices_pollerHostId_fkey" FOREIGN KEY ("pollerHostId") REFERENCES "monitored_hosts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "network_interfaces" ADD CONSTRAINT "network_interfaces_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "network_devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "database_instances" ADD CONSTRAINT "database_instances_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "database_instances" ADD CONSTRAINT "database_instances_hostId_fkey" FOREIGN KEY ("hostId") REFERENCES "monitored_hosts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "slow_query_logs" ADD CONSTRAINT "slow_query_logs_dbInstanceId_fkey" FOREIGN KEY ("dbInstanceId") REFERENCES "database_instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "endpoint_checks" ADD CONSTRAINT "endpoint_checks_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "topology_nodes" ADD CONSTRAINT "topology_nodes_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_dependencies" ADD CONSTRAINT "service_dependencies_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_dependencies" ADD CONSTRAINT "service_dependencies_parentNodeId_fkey" FOREIGN KEY ("parentNodeId") REFERENCES "topology_nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_dependencies" ADD CONSTRAINT "service_dependencies_childNodeId_fkey" FOREIGN KEY ("childNodeId") REFERENCES "topology_nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert_rules" ADD CONSTRAINT "alert_rules_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert_rules" ADD CONSTRAINT "alert_rules_remediationActionId_fkey" FOREIGN KEY ("remediationActionId") REFERENCES "remediation_actions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "alert_rules"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incident_events" ADD CONSTRAINT "incident_events_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "incidents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "remediation_actions" ADD CONSTRAINT "remediation_actions_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "remediation_actions" ADD CONSTRAINT "remediation_actions_targetHostId_fkey" FOREIGN KEY ("targetHostId") REFERENCES "monitored_hosts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "remediation_executions" ADD CONSTRAINT "remediation_executions_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "remediation_executions" ADD CONSTRAINT "remediation_executions_actionId_fkey" FOREIGN KEY ("actionId") REFERENCES "remediation_actions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "remediation_executions" ADD CONSTRAINT "remediation_executions_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "incidents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "remediation_executions" ADD CONSTRAINT "remediation_executions_hostId_fkey" FOREIGN KEY ("hostId") REFERENCES "monitored_hosts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finops_recommendations" ADD CONSTRAINT "finops_recommendations_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finops_recommendations" ADD CONSTRAINT "finops_recommendations_hostId_fkey" FOREIGN KEY ("hostId") REFERENCES "monitored_hosts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

