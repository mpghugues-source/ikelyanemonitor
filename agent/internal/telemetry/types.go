// Package telemetry implements the wire format IkelyaneMonitor's ingestion endpoint expects.
// The JSON shape here MUST match src/lib/telemetry/schemas.ts in the main app — see
// docs/telemetry.md for the authoritative protocol description.
package telemetry

// SchemaVersion is the only value the server currently accepts.
const SchemaVersion = 1

// Payload is the request body. At least one of System, SNMPDevices or Databases must be set;
// this agent (host-metrics only, for now) always sets System.
type Payload struct {
	SchemaVersion int       `json:"schemaVersion"`
	SentAt        string    `json:"sentAt"` // RFC3339, when this request was built
	Agent         AgentInfo `json:"agent"`
	System        *System   `json:"system,omitempty"`
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
