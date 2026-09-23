// Package telemetry implements the wire format IkelyaneMonitor's ingestion endpoint expects.
// The JSON shape here MUST match src/lib/telemetry/schemas.ts in the main app — see
// docs/telemetry.md for the authoritative protocol description.
package telemetry

// SchemaVersion is the only value the server currently accepts.
const SchemaVersion = 1

// Payload is the request body. At least one of System, SNMPDevices or Databases must be set;
// this agent always sets System, SNMPDevices whenever the poller-config fetch (see
// internal/pollerconfig) returned at least one assigned device, and Databases whenever the agent
// is configured to monitor at least one (internal/dbmetrics).
type Payload struct {
	SchemaVersion int              `json:"schemaVersion"`
	SentAt        string           `json:"sentAt"` // RFC3339, when this request was built
	Agent         AgentInfo        `json:"agent"`
	System        *System          `json:"system,omitempty"`
	SNMPDevices   []SnmpDevice     `json:"snmpDevices,omitempty"`
	Databases     []DatabaseMetric `json:"databases,omitempty"`
}

type AgentInfo struct {
	Version string `json:"version"`
}

// Inventory is sent at startup and periodically thereafter (see Collector.inventoryEvery) rather
// than on every sample: it rarely changes and there is no point re-sending it every few seconds.
type Inventory struct {
	OSFamily         string   `json:"osFamily"` // windows | linux | macos | unix | other
	OSName           string   `json:"osName,omitempty"`
	OSVersion        string   `json:"osVersion,omitempty"`
	KernelVersion    string   `json:"kernelVersion,omitempty"`
	Arch             string   `json:"arch,omitempty"`
	CPUModel         string   `json:"cpuModel,omitempty"`
	CPUCores         int      `json:"cpuCores,omitempty"`
	CPUThreads       int      `json:"cpuThreads,omitempty"`
	CPUFrequencyMhz  int      `json:"cpuFrequencyMhz,omitempty"`
	MemoryTotalBytes uint64   `json:"memoryTotalBytes,omitempty"`
	DiskTotalBytes   uint64   `json:"diskTotalBytes,omitempty"`
	IPAddresses      []string `json:"ipAddresses,omitempty"`
	MACAddress       string   `json:"macAddress,omitempty"`
	Virtualization   string   `json:"virtualization,omitempty"`
	AgentVersion     string   `json:"agentVersion,omitempty"`
}

type CPU struct {
	UsagePercent  float64  `json:"usagePercent"`
	LoadAverage1m *float64 `json:"loadAverage1m,omitempty"`
}

type Memory struct {
	UsedPercent     *float64 `json:"usedPercent,omitempty"`
	UsedBytes       *uint64  `json:"usedBytes,omitempty"`
	SwapUsedPercent *float64 `json:"swapUsedPercent,omitempty"`
}

// Disk is one mounted filesystem. IOPS/throughput are rates (this cycle's delta over the previous
// one) and are nil on the agent's very first sample, when there is nothing to compare against.
type Disk struct {
	Mount       string   `json:"mount"`
	Device      string   `json:"device,omitempty"`
	UsedPercent *float64 `json:"usedPercent,omitempty"`
	UsedBytes   *uint64  `json:"usedBytes,omitempty"`
	ReadIops    *float64 `json:"readIops,omitempty"`
	WriteIops   *float64 `json:"writeIops,omitempty"`
	ReadBps     *float64 `json:"readBps,omitempty"`
	WriteBps    *float64 `json:"writeBps,omitempty"`
}

// Network is one interface. In/OutBps are BITS per second (matches the server schema and typical
// network monitoring convention), derived from the byte counters gopsutil reports.
type Network struct {
	Name   string  `json:"name"`
	InBps  float64 `json:"inBps"`
	OutBps float64 `json:"outBps"`
}

type Temperature struct {
	Sensor  string  `json:"sensor"`
	Celsius float64 `json:"celsius"`
}

type System struct {
	CollectedAt   string        `json:"collectedAt"` // RFC3339
	Inventory     *Inventory    `json:"inventory,omitempty"`
	CPU           *CPU          `json:"cpu,omitempty"`
	Memory        *Memory       `json:"memory,omitempty"`
	Disks         []Disk        `json:"disks,omitempty"`
	Network       []Network     `json:"network,omitempty"`
	ProcessCount  *int          `json:"processCount,omitempty"`
	UptimeSeconds *float64      `json:"uptimeSeconds,omitempty"`
	Temperatures  []Temperature `json:"temperatures,omitempty"`
	PowerWatts    *float64      `json:"powerWatts,omitempty"`
}

// ── SNMP devices ──────────────────────────────────────────────────────────────────────────────
// Mirrors src/lib/telemetry/schemas.ts SnmpDeviceSchema/SnmpInterfaceSchema exactly — field names,
// optionality and units. Vendor/model/firmwareVersion/serialNumber/temperatureCelsius/powerWatts
// have no portable SNMP source (ENTITY-MIB and hardware sensors are vendor-specific) and are left
// unset for now; packetLossPercent would need ICMP, which this agent does not do — also unset.

// SnmpDeviceInfo is the "device" object of one snmpDevices[] entry.
type SnmpDeviceInfo struct {
	IPAddress     string   `json:"ipAddress"`
	Name          string   `json:"name,omitempty"`
	Type          string   `json:"type,omitempty"` // router | switch | firewall | ap | ups | bmc | other
	SysName       string   `json:"sysName,omitempty"`
	SysDescr      string   `json:"sysDescr,omitempty"`
	UptimeSeconds *float64 `json:"uptimeSeconds,omitempty"`
	SNMPVersion   string   `json:"snmpVersion,omitempty"` // v1 | v2c | v3
	Reachable     bool     `json:"reachable"`
	LatencyMs     *float64 `json:"latencyMs,omitempty"`
}

type SnmpInterface struct {
	IfIndex     int    `json:"ifIndex"`
	Name        string `json:"name"`
	Alias       string `json:"alias,omitempty"`
	SpeedMbps   *int   `json:"speedMbps,omitempty"`
	AdminStatus string `json:"adminStatus,omitempty"` // up | down | testing | unknown
	OperStatus  string `json:"operStatus"`            // up | down | testing | unknown

	// Rates computed by the agent from counter deltas; zero (not omitted, the schema requires
	// them) on the very first poll of a device, same convention as host network metrics.
	InBps              float64  `json:"inBps"`
	OutBps             float64  `json:"outBps"`
	UtilizationPercent *float64 `json:"utilizationPercent,omitempty"`
	PacketLossPercent  *float64 `json:"packetLossPercent,omitempty"`

	// Cumulative counters as read from the device.
	InErrors    *uint64 `json:"inErrors,omitempty"`
	OutErrors   *uint64 `json:"outErrors,omitempty"`
	CrcErrors   *uint64 `json:"crcErrors,omitempty"`
	InDiscards  *uint64 `json:"inDiscards,omitempty"`
	OutDiscards *uint64 `json:"outDiscards,omitempty"`

	ErrorsPerSec    *float64 `json:"errorsPerSec,omitempty"`
	CrcErrorsPerSec *float64 `json:"crcErrorsPerSec,omitempty"`
}

type SnmpDevice struct {
	CollectedAt string          `json:"collectedAt"`
	Device      SnmpDeviceInfo  `json:"device"`
	Interfaces  []SnmpInterface `json:"interfaces"`
}

// ── Databases ─────────────────────────────────────────────────────────────────────────────────
// Mirrors src/lib/telemetry/schemas.ts DatabaseMetricSchema/SlowQuerySchema exactly. Credentials
// are configured locally on the agent (internal/config) and never appear here — see Endpoint's
// doc comment for what that means for its value specifically.

type DatabaseInstanceInfo struct {
	// Stable identifier CHOSEN BY THE OPERATOR in the agent's own config (internal/config), unique
	// per host+engine — e.g. "main:5432". Must never change across restarts: the server keys its
	// upsert on it, so a changed name creates a second instance rather than updating the first.
	Name string `json:"name"`
	// postgresql | mysql | mariadb (this agent's engines so far; mongodb | redis | mssql also on
	// the wire per docs/telemetry.md, not implemented here).
	Engine               string  `json:"engine"`
	Version              string  `json:"version,omitempty"`
	Endpoint             string  `json:"endpoint,omitempty"` // "host:port" — NEVER credentials, see internal/dbmetrics/dsn.go
	IsReplica            *bool   `json:"isReplica,omitempty"`
	StorageQuotaBytes    *uint64 `json:"storageQuotaBytes,omitempty"`
	MaxConnections       *int    `json:"maxConnections,omitempty"`
	SlowQueryThresholdMs *int    `json:"slowQueryThresholdMs,omitempty"`
}

type DatabaseMetrics struct {
	QPS                    *float64 `json:"qps,omitempty"`
	ActiveConnections      *int     `json:"activeConnections,omitempty"`
	ConnectionUsagePercent *float64 `json:"connectionUsagePercent,omitempty"`
	CacheHitRatio          *float64 `json:"cacheHitRatio,omitempty"` // 0..1
	SlowQueriesPerMin      *float64 `json:"slowQueriesPerMin,omitempty"`
	DeadlocksPerMin        *float64 `json:"deadlocksPerMin,omitempty"`
	DeadlocksTotal         *uint64  `json:"deadlocksTotal,omitempty"`
	ReplicationLagSeconds  *float64 `json:"replicationLagSeconds,omitempty"`
	StorageUsedBytes       *uint64  `json:"storageUsedBytes,omitempty"`
}

// SlowQuery reports a NORMALIZED statement (literals already replaced by placeholders BY THE
// DATABASE ENGINE ITSELF — Postgres's pg_stat_statements and MySQL/MariaDB's performance_schema
// digest both aggregate by normalized shape, so what they hand back is already safe to send) that
// executed at least once more since the previous poll. DurationMs is that statement shape's AVERAGE
// duration over the interval (these engines expose aggregates, not a per-execution log), and Calls
// is how many additional executions were observed — not a single literal event.
type SlowQuery struct {
	CapturedAt   string  `json:"capturedAt"`
	Fingerprint  string  `json:"fingerprint"`
	QueryText    string  `json:"queryText,omitempty"`
	DurationMs   float64 `json:"durationMs"`
	Calls        *int    `json:"calls,omitempty"`
	RowsExamined *uint64 `json:"rowsExamined,omitempty"`
	RowsReturned *uint64 `json:"rowsReturned,omitempty"`
}

type DatabaseMetric struct {
	CollectedAt string               `json:"collectedAt"`
	Instance    DatabaseInstanceInfo `json:"instance"`
	Reachable   bool                 `json:"reachable"`
	Metrics     DatabaseMetrics      `json:"metrics"`
	SlowQueries []SlowQuery          `json:"slowQueries,omitempty"`
}
