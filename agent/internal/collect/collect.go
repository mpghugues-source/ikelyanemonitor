// Package collect gathers host metrics via gopsutil and shapes them into telemetry.System.
//
// Rates (disk IOPS/throughput, network bandwidth) need two samples to compute: gopsutil exposes
// cumulative counters, not rates. Collector keeps the previous sample in memory and derives a rate
// from the delta on every call after the first — the first call after startup reports no rates.
package collect

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/shirou/gopsutil/v4/cpu"
	gdisk "github.com/shirou/gopsutil/v4/disk"
	"github.com/shirou/gopsutil/v4/host"
	"github.com/shirou/gopsutil/v4/load"
	"github.com/shirou/gopsutil/v4/mem"
	gnet "github.com/shirou/gopsutil/v4/net"
	"github.com/shirou/gopsutil/v4/process"
	"github.com/shirou/gopsutil/v4/sensors"

	"ikelyane-agent/internal/telemetry"
)

// inventoryEvery bounds how often the (rarely-changing) inventory block is re-sent: at startup,
// then again on this cadence, rather than on every sample — see docs/telemetry.md.
const inventoryEvery = time.Hour

// cpuSampleWindow is how long cpu.Percent blocks to compute a delta-based usage percentage. Short
// enough not to noticeably delay a collection cycle, long enough for a stable reading.
const cpuSampleWindow = time.Second

type diskSample struct {
	at    time.Time
	stats map[string]gdisk.IOCountersStat
}

type netSample struct {
	at    time.Time
	stats map[string]gnet.IOCountersStat
}

// Collector holds state between calls (previous counters, when inventory was last sent).
type Collector struct {
	agentVersion string

	prevDisk        *diskSample
	prevNet         *netSample
	lastInventoryAt time.Time
}

func New(agentVersion string) *Collector {
	return &Collector{agentVersion: agentVersion}
}

// Collect gathers one sample. Errors from individual sub-collectors (a sensor that doesn't exist
// on this machine, a permission issue) are logged by the caller and simply omit that field —
// nothing about a single failed reading should stop the whole cycle.
func (c *Collector) Collect(ctx context.Context) (*telemetry.System, []error) {
	var warnings []error
	now := time.Now().UTC()

	sys := &telemetry.System{CollectedAt: now.Format(time.RFC3339)}

	if inv, err := c.inventory(ctx, now); err != nil {
		warnings = append(warnings, fmt.Errorf("inventory: %w", err))
	} else {
		sys.Inventory = inv
	}

	if cpuMetrics, err := collectCPU(ctx); err != nil {
		warnings = append(warnings, fmt.Errorf("cpu: %w", err))
	} else {
		sys.CPU = cpuMetrics
	}

	if memMetrics, err := collectMemory(); err != nil {
		warnings = append(warnings, fmt.Errorf("memory: %w", err))
	} else {
		sys.Memory = memMetrics
	}

	disks, diskTotal, err := c.collectDisks(now)
	if err != nil {
		warnings = append(warnings, fmt.Errorf("disks: %w", err))
	} else {
		sys.Disks = disks
	}
	if sys.Inventory != nil && diskTotal > 0 {
		sys.Inventory.DiskTotalBytes = diskTotal
	}

	netStats, err := c.collectNetwork(now)
	if err != nil {
		warnings = append(warnings, fmt.Errorf("network: %w", err))
	} else {
		sys.Network = netStats
	}

	if temps, err := sensors.TemperaturesWithContext(ctx); err == nil {
		for _, t := range temps {
			if t.SensorKey == "" || t.Temperature == 0 {
				continue
			}
			sys.Temperatures = append(sys.Temperatures, telemetry.Temperature{Sensor: t.SensorKey, Celsius: t.Temperature})
		}
	} // best-effort: many VMs expose no sensors at all — not worth a warning.

	if hostInfo, err := host.InfoWithContext(ctx); err == nil {
		uptime := float64(hostInfo.Uptime)
		sys.UptimeSeconds = &uptime
	} else {
		warnings = append(warnings, fmt.Errorf("uptime: %w", err))
	}

	if pids, err := process.PidsWithContext(ctx); err == nil {
		count := len(pids)
		sys.ProcessCount = &count
	} // best-effort: not every platform/permission set can enumerate PIDs.

	return sys, warnings
}

func (c *Collector) inventory(ctx context.Context, now time.Time) (*telemetry.Inventory, error) {
	if !c.lastInventoryAt.IsZero() && now.Sub(c.lastInventoryAt) < inventoryEvery {
		return nil, nil
	}

	hostInfo, err := host.InfoWithContext(ctx)
	if err != nil {
		return nil, err
	}
	cpuInfo, _ := cpu.InfoWithContext(ctx) // best-effort: model/frequency are nice-to-have
	logicalCount, _ := cpu.CountsWithContext(ctx, true)
	physicalCount, _ := cpu.CountsWithContext(ctx, false)
	vmem, _ := mem.VirtualMemoryWithContext(ctx)
	addrs, _ := hostIPAddresses()

	inv := &telemetry.Inventory{
		OSFamily:       osFamily(hostInfo.OS),
		OSName:         hostInfo.Platform,
		OSVersion:      hostInfo.PlatformVersion,
		KernelVersion:  hostInfo.KernelVersion,
		Arch:           hostInfo.KernelArch,
		CPUCores:       physicalCount,
		CPUThreads:     logicalCount,
		IPAddresses:    addrs,
		Virtualization: hostInfo.VirtualizationSystem,
		AgentVersion:   c.agentVersion,
	}
	if vmem != nil {
		inv.MemoryTotalBytes = vmem.Total
	}
	if len(cpuInfo) > 0 {
		inv.CPUModel = cpuInfo[0].ModelName
		inv.CPUFrequencyMhz = int(cpuInfo[0].Mhz)
	}

	c.lastInventoryAt = now
	return inv, nil
}

// osFamily maps gopsutil's host.InfoStat.OS (Go's GOOS: "linux", "windows", "darwin", "freebsd", …)
// onto the server's fixed enum (schemas.ts OS_FAMILIES).
func osFamily(goos string) string {
	switch goos {
	case "windows":
		return "windows"
	case "linux":
		return "linux"
	case "darwin":
		return "macos"
	case "freebsd", "openbsd", "netbsd", "dragonfly", "solaris", "aix":
		return "unix"
	default:
		return "other"
	}
}

func collectCPU(ctx context.Context) (*telemetry.CPU, error) {
	percents, err := cpu.PercentWithContext(ctx, cpuSampleWindow, false)
	if err != nil || len(percents) == 0 {
		return nil, fmt.Errorf("cpu.Percent: %w", err)
	}
	out := &telemetry.CPU{UsagePercent: clampPercent(percents[0])}
	// load.Avg has no meaning on Windows; gopsutil returns an error there, which we treat as
	// "unavailable" rather than a collection failure.
	if avg, err := load.AvgWithContext(ctx); err == nil {
		l := avg.Load1
		out.LoadAverage1m = &l
	}
	return out, nil
}

func collectMemory() (*telemetry.Memory, error) {
	vmem, err := mem.VirtualMemory()
	if err != nil {
		return nil, err
	}
	out := &telemetry.Memory{}
	used := clampPercent(vmem.UsedPercent)
	out.UsedPercent = &used
	usedBytes := vmem.Used
	out.UsedBytes = &usedBytes

	if swap, err := mem.SwapMemory(); err == nil && swap.Total > 0 {
		swapPercent := clampPercent(swap.UsedPercent)
		out.SwapUsedPercent = &swapPercent
	}
	return out, nil
}

func (c *Collector) collectDisks(now time.Time) ([]telemetry.Disk, uint64, error) {
	partitions, err := gdisk.Partitions(false)
	if err != nil {
		return nil, 0, err
	}

	ioCounters, ioErr := gdisk.IOCounters()
	var elapsed time.Duration
	var prevIO map[string]gdisk.IOCountersStat
	if c.prevDisk != nil {
		elapsed = now.Sub(c.prevDisk.at)
		prevIO = c.prevDisk.stats
	}

	var totalBytes uint64
	disks := make([]telemetry.Disk, 0, len(partitions))
	for _, p := range partitions {
		usage, err := gdisk.Usage(p.Mountpoint)
		if err != nil {
			continue // e.g. a removable/network mount that vanished between listing and reading
		}
		totalBytes += usage.Total

		d := telemetry.Disk{Mount: p.Mountpoint, Device: deviceName(p.Device)}
		usedPercent := clampPercent(usage.UsedPercent)
		d.UsedPercent = &usedPercent
		usedBytes := usage.Used
		d.UsedBytes = &usedBytes

		if ioErr == nil && prevIO != nil && elapsed > 0 {
			if cur, ok := ioCounters[d.Device]; ok {
				if prev, ok := prevIO[d.Device]; ok {
					seconds := elapsed.Seconds()
					readIops := rate(cur.ReadCount, prev.ReadCount, seconds)
					writeIops := rate(cur.WriteCount, prev.WriteCount, seconds)
					readBps := rate(cur.ReadBytes, prev.ReadBytes, seconds)
					writeBps := rate(cur.WriteBytes, prev.WriteBytes, seconds)
					d.ReadIops, d.WriteIops, d.ReadBps, d.WriteBps = &readIops, &writeIops, &readBps, &writeBps
				}
			}
		}
		disks = append(disks, d)
	}

	if ioErr == nil {
		c.prevDisk = &diskSample{at: now, stats: ioCounters}
	}
	return disks, totalBytes, nil
}

func (c *Collector) collectNetwork(now time.Time) ([]telemetry.Network, error) {
	counters, err := gnet.IOCounters(true)
	if err != nil {
		return nil, err
	}

	var elapsed time.Duration
	var prev map[string]gnet.IOCountersStat
	if c.prevNet != nil {
		elapsed = now.Sub(c.prevNet.at)
		prev = c.prevNet.stats
	}

	current := make(map[string]gnet.IOCountersStat, len(counters))
	out := make([]telemetry.Network, 0, len(counters))
	for _, ctr := range counters {
		if isLoopbackName(ctr.Name) || isVirtualInterfaceName(ctr.Name) {
			continue
		}
		current[ctr.Name] = ctr
		var inBps, outBps float64
		if prev != nil && elapsed > 0 {
			if p, ok := prev[ctr.Name]; ok {
				seconds := elapsed.Seconds()
				// bytes/s * 8 = bits/s, matching the server's convention (schemas.ts comment "bits per second").
				inBps = rate(ctr.BytesRecv, p.BytesRecv, seconds) * 8
				outBps = rate(ctr.BytesSent, p.BytesSent, seconds) * 8
			}
		}
		out = append(out, telemetry.Network{Name: ctr.Name, InBps: inBps, OutBps: outBps})
	}

	c.prevNet = &netSample{at: now, stats: current}
	return out, nil
}

// rate computes (cur-prev)/seconds, guarding against a counter that reset (device replaced,
// overflow) by reporting 0 instead of a nonsensical negative rate.
func rate(cur, prev uint64, seconds float64) float64 {
	if seconds <= 0 || cur < prev {
		return 0
	}
	return float64(cur-prev) / seconds
}

func clampPercent(v float64) float64 {
	if v < 0 {
		return 0
	}
	if v > 100 {
		return 100
	}
	return v
}

func deviceName(path string) string {
	// Strip a directory prefix if gopsutil ever returns one (it usually doesn't on Linux, sometimes
	// does on other platforms); the server only stores this as a short label, not a path.
	for i := len(path) - 1; i >= 0; i-- {
		if path[i] == '/' || path[i] == '\\' {
			return path[i+1:]
		}
	}
	return path
}

func isLoopbackName(name string) bool {
	return name == "lo" || name == "lo0"
}

// virtualInterfacePrefixes are container/virtualization plumbing (Docker bridges and veth pairs,
// libvirt, Kubernetes CNI plugins…): internal to the host, not something an operator monitoring
// "this server's network" wants to see — and on a Docker host there can be dozens of them,
// swamping the handful of real interfaces. Found by actually running the agent on this project's
// own Docker-heavy dev server, not guessed: without this filter a single host reported network
// metrics for a dozen veth/bridge interfaces alongside its one real NIC.
var virtualInterfacePrefixes = []string{
	"docker", "br-", "veth", "virbr", "vnet", "cni", "flannel", "kube-", "cali", "tap", "tun",
}

func isVirtualInterfaceName(name string) bool {
	for _, prefix := range virtualInterfacePrefixes {
		if strings.HasPrefix(name, prefix) {
			return true
		}
	}
	return false
}

// hostIPAddresses lists non-loopback, non-virtual IPv4/IPv6 addresses across all interfaces, via
// gopsutil so the same code path works on every platform this agent targets.
func hostIPAddresses() ([]string, error) {
	ifaces, err := gnet.Interfaces()
	if err != nil {
		return nil, err
	}
	var addrs []string
	for _, iface := range ifaces {
		if isLoopbackName(iface.Name) || isVirtualInterfaceName(iface.Name) {
			continue
		}
		for _, a := range iface.Addrs {
			ip := a.Addr
			if idx := indexByte(ip, '/'); idx >= 0 { // gopsutil returns CIDR-style "ip/prefix"
				ip = ip[:idx]
			}
			if ip != "" {
				addrs = append(addrs, ip)
			}
			if len(addrs) >= 32 { // matches the server's HostInventorySchema.ipAddresses cap
				return addrs, nil
			}
		}
	}
	return addrs, nil
}

func indexByte(s string, b byte) int {
	for i := 0; i < len(s); i++ {
		if s[i] == b {
			return i
		}
	}
	return -1
}
