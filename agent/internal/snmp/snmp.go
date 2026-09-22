// Package snmp polls network equipment over SNMP v1/v2c/v3 (github.com/gosnmp/gosnmp — hand-rolling
// ASN.1 BER encoding and, especially, the v3 USM security model would be a large, easy-to-get-subtly-wrong
// undertaking; gosnmp is the Go ecosystem's established choice here, same reasoning as gopsutil for
// host metrics) and shapes the result into telemetry.SnmpDevice.
//
// Standard MIB-II / IF-MIB only: vendor/model/firmwareVersion/serialNumber (ENTITY-MIB) and
// temperature/power (hardware-specific) have no portable OID and are left unset. Interfaces with no
// EtherLike-MIB support simply report no CRC error count — never a failure.
package snmp

import (
	"fmt"
	"sync"
	"time"

	"github.com/gosnmp/gosnmp"

	"ikelyane-agent/internal/pollerconfig"
	"ikelyane-agent/internal/telemetry"
)

var authProtocols = map[string]gosnmp.SnmpV3AuthProtocol{
	"MD5": gosnmp.MD5, "SHA": gosnmp.SHA, "SHA224": gosnmp.SHA224,
	"SHA256": gosnmp.SHA256, "SHA384": gosnmp.SHA384, "SHA512": gosnmp.SHA512,
}

var privProtocols = map[string]gosnmp.SnmpV3PrivProtocol{
	"DES": gosnmp.DES, "AES": gosnmp.AES, "AES192": gosnmp.AES192, "AES256": gosnmp.AES256,
}

var securityLevels = map[string]gosnmp.SnmpV3MsgFlags{
	"NO_AUTH_NO_PRIV": gosnmp.NoAuthNoPriv, "AUTH_NO_PRIV": gosnmp.AuthNoPriv, "AUTH_PRIV": gosnmp.AuthPriv,
}

func buildParams(device pollerconfig.Device) (*gosnmp.GoSNMP, error) {
	params := &gosnmp.GoSNMP{
		Target:  device.IPAddress,
		Port:    uint16(device.SNMP.Port),
		Timeout: time.Duration(device.SNMP.TimeoutMs) * time.Millisecond,
		Retries: device.SNMP.Retries,
	}

	switch device.SNMP.Version {
	case "v1":
		params.Version = gosnmp.Version1
		params.Community = device.SNMP.Community
	case "v2c":
		params.Version = gosnmp.Version2c
		params.Community = device.SNMP.Community
	case "v3":
		if device.SNMP.V3 == nil {
			return nil, fmt.Errorf("device configured for SNMPv3 but the server sent no v3 credentials")
		}
		v3 := device.SNMP.V3
		msgFlags, ok := securityLevels[v3.SecurityLevel]
		if !ok {
			return nil, fmt.Errorf("unknown SNMPv3 security level %q", v3.SecurityLevel)
		}
		usm := &gosnmp.UsmSecurityParameters{UserName: v3.Username}
		if msgFlags == gosnmp.AuthNoPriv || msgFlags == gosnmp.AuthPriv {
			proto, ok := authProtocols[v3.AuthProtocol]
			if !ok {
				return nil, fmt.Errorf("unknown SNMPv3 auth protocol %q", v3.AuthProtocol)
			}
			usm.AuthenticationProtocol = proto
			usm.AuthenticationPassphrase = v3.AuthKey
		}
		if msgFlags == gosnmp.AuthPriv {
			proto, ok := privProtocols[v3.PrivProtocol]
			if !ok {
				return nil, fmt.Errorf("unknown SNMPv3 priv protocol %q", v3.PrivProtocol)
			}
			usm.PrivacyProtocol = proto
			usm.PrivacyPassphrase = v3.PrivKey
		}
		params.Version = gosnmp.Version3
		params.MsgFlags = msgFlags
		params.SecurityModel = gosnmp.UserSecurityModel
		params.SecurityParameters = usm
		params.ContextName = v3.ContextName
	default:
		return nil, fmt.Errorf("unknown SNMP version %q", device.SNMP.Version)
	}
	return params, nil
}

// ifState is the previous poll's counters for one device interface, kept to compute rates.
type ifState struct {
	at        time.Time
	inOctets  uint64
	outOctets uint64
	inErrors  uint64
	outErrors uint64
	crcErrors uint64
}

// Poller holds counter state between polls, one entry per (device, interface) — keyed loosely by
// device IP since that already uniquely identifies a device within an organization (schema:
// NetworkDevice is unique on (orgId, ipAddress)).
//
// Safe for concurrent use by multiple goroutines: the caller (cmd/ikelyane-agent) polls several
// devices in parallel to bound how long one cycle takes when some devices are unreachable, and
// every device shares this same Poller for its counter-delta state.
type Poller struct {
	mu   sync.Mutex
	prev map[string]ifState
}

func New() *Poller {
	return &Poller{prev: make(map[string]ifState)}
}

// swapPrev atomically stores next under key and returns whatever was there before (and whether
// there was anything at all) — the single map access point, so concurrent Poll calls never touch
// the map directly.
func (p *Poller) swapPrev(key string, next ifState) (previous ifState, existed bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	previous, existed = p.prev[key]
	p.prev[key] = next
	return previous, existed
}

// Poll queries one device. It never returns an error: an unreachable device is a normal, expected
// outcome (docs/telemetry.md: reachable=false marks it DOWN server-side) — the caller always gets
// something to include in the batch, logging is the caller's job if it wants to.
func (p *Poller) Poll(device pollerconfig.Device, now time.Time) telemetry.SnmpDevice {
	collectedAt := now.Format(time.RFC3339)
	info := telemetry.SnmpDeviceInfo{IPAddress: device.IPAddress, Type: device.Type, SNMPVersion: device.SNMP.Version}

	params, err := buildParams(device)
	if err != nil {
		info.Reachable = false
		return telemetry.SnmpDevice{CollectedAt: collectedAt, Device: info}
	}

	start := time.Now()
	if err := params.Connect(); err != nil {
		info.Reachable = false
		return telemetry.SnmpDevice{CollectedAt: collectedAt, Device: info}
	}
	defer params.Conn.Close()

	sysResult, err := params.Get([]string{oidSysDescr, oidSysUpTime, oidSysName})
	if err != nil {
		info.Reachable = false
		return telemetry.SnmpDevice{CollectedAt: collectedAt, Device: info}
	}
	latencyMs := float64(time.Since(start)) / float64(time.Millisecond)
	info.Reachable = true
	info.LatencyMs = &latencyMs

	for _, v := range sysResult.Variables {
		switch v.Name {
		case oidSysDescr:
			info.SysDescr = truncate(pduString(v), 2000)
		case oidSysName:
			info.Name = truncate(pduString(v), 255)
			info.SysName = info.Name
		case oidSysUpTime:
			// sysUpTime is in TimeTicks (hundredths of a second).
			ticks := pduUint(v)
			seconds := float64(ticks) / 100
			info.UptimeSeconds = &seconds
		}
	}

	interfaces := p.pollInterfaces(params, device.IPAddress, now)
	return telemetry.SnmpDevice{CollectedAt: collectedAt, Device: info, Interfaces: interfaces}
}

type ifRow struct {
	index                                        int
	descr, name, alias                           string
	speed, highSpeed                             uint64
	adminStatus, operStatus                      int
	inOctets, outOctets, hcInOctets, hcOutOctets uint64
	inErrors, outErrors, inDiscards, outDiscards uint64
	crcErrors                                    uint64
	hasHCCounters                                bool
}

func (p *Poller) pollInterfaces(params *gosnmp.GoSNMP, deviceIP string, now time.Time) []telemetry.SnmpInterface {
	rows := map[int]*ifRow{}
	row := func(idx int) *ifRow {
		r, ok := rows[idx]
		if !ok {
			r = &ifRow{index: idx}
			rows[idx] = r
		}
		return r
	}

	_ = params.Walk(oidIfTable, func(pdu gosnmp.SnmpPDU) error {
		col, idx, ok := tableIndex(pdu.Name, oidIfTable)
		if !ok {
			return nil
		}
		r := row(idx)
		switch col {
		case colIfDescr:
			r.descr = pduString(pdu)
		case colIfSpeed:
			r.speed = pduUint(pdu)
		case colIfAdminStatus:
			r.adminStatus = int(pduUint(pdu))
		case colIfOperStatus:
			r.operStatus = int(pduUint(pdu))
		case colIfInOctets:
			r.inOctets = pduUint(pdu)
		case colIfOutOctets:
			r.outOctets = pduUint(pdu)
		case colIfInErrors:
			r.inErrors = pduUint(pdu)
		case colIfOutErrors:
			r.outErrors = pduUint(pdu)
		case colIfInDiscards:
			r.inDiscards = pduUint(pdu)
		case colIfOutDiscards:
			r.outDiscards = pduUint(pdu)
		}
		return nil
	}) // best-effort: a partial/failed walk still yields whatever rows were read before the error

	// ifXTable: better names and 64-bit counters, not guaranteed on older devices — a failed walk
	// here just means every row below falls back to its ifTable (32-bit) values.
	_ = params.Walk(oidIfXTable, func(pdu gosnmp.SnmpPDU) error {
		col, idx, ok := tableIndex(pdu.Name, oidIfXTable)
		if !ok {
			return nil
		}
		r := row(idx)
		switch col {
		case colIfName:
			r.name = pduString(pdu)
		case colIfAlias:
			r.alias = pduString(pdu)
		case colIfHighSpeed:
			r.highSpeed = pduUint(pdu)
		case colIfHCInOctets:
			r.hcInOctets = pduUint(pdu)
			r.hasHCCounters = true
		case colIfHCOutOctets:
			r.hcOutOctets = pduUint(pdu)
			r.hasHCCounters = true
		}
		return nil
	})

	_ = params.Walk(oidDot3StatsFCSErrors, func(pdu gosnmp.SnmpPDU) error {
		idx, ok := singleIndex(pdu.Name, oidDot3StatsFCSErrors)
		if !ok {
			return nil
		}
		if r, exists := rows[idx]; exists {
			r.crcErrors = pduUint(pdu)
		}
		return nil
	})

	out := make([]telemetry.SnmpInterface, 0, len(rows))
	for _, r := range rows {
		out = append(out, p.toInterface(deviceIP, r, now))
	}
	return out
}

func (p *Poller) toInterface(deviceIP string, r *ifRow, now time.Time) telemetry.SnmpInterface {
	name := r.name
	if name == "" {
		name = r.descr
	}
	if name == "" {
		name = fmt.Sprintf("if%d", r.index)
	}

	inOctets, outOctets := r.inOctets, r.outOctets
	if r.hasHCCounters {
		inOctets, outOctets = r.hcInOctets, r.hcOutOctets
	}

	iface := telemetry.SnmpInterface{
		IfIndex:     r.index,
		Name:        truncate(name, 255),
		Alias:       truncate(r.alias, 255),
		AdminStatus: ifStatusString(r.adminStatus),
		OperStatus:  ifStatusString(r.operStatus),
		InErrors:    ref(r.inErrors),
		OutErrors:   ref(r.outErrors),
		InDiscards:  ref(r.inDiscards),
		OutDiscards: ref(r.outDiscards),
	}
	if r.crcErrors > 0 || r.hasHCCounters { // avoid claiming "0 CRC errors" for ports the walk never reached
		iface.CrcErrors = ref(r.crcErrors)
	}

	speedBps := r.highSpeed * 1_000_000 // ifHighSpeed is in Mbps
	if speedBps == 0 {
		speedBps = r.speed // ifSpeed is already in bps
	}
	if speedBps > 0 {
		mbps := int(speedBps / 1_000_000)
		iface.SpeedMbps = &mbps
	}

	key := fmt.Sprintf("%s|%d", deviceIP, r.index)
	next := ifState{at: now, inOctets: inOctets, outOctets: outOctets, inErrors: r.inErrors, outErrors: r.outErrors, crcErrors: r.crcErrors}
	prev, hadPrev := p.swapPrev(key, next)

	if hadPrev {
		seconds := now.Sub(prev.at).Seconds()
		if seconds > 0 {
			inBps := rate(inOctets, prev.inOctets, seconds) * 8
			outBps := rate(outOctets, prev.outOctets, seconds) * 8
			iface.InBps, iface.OutBps = inBps, outBps

			errRate := rate(r.inErrors, prev.inErrors, seconds) + rate(r.outErrors, prev.outErrors, seconds)
			iface.ErrorsPerSec = &errRate
			if iface.CrcErrors != nil {
				crcRate := rate(r.crcErrors, prev.crcErrors, seconds)
				iface.CrcErrorsPerSec = &crcRate
			}

			if speedBps > 0 {
				util := clampPercent(((inBps + outBps) / 2) / float64(speedBps) * 100)
				iface.UtilizationPercent = &util
			}
		}
	}
	return iface
}

func ifStatusString(v int) string {
	switch v {
	case 1:
		return "up"
	case 2:
		return "down"
	case 3:
		return "testing"
	default:
		return "unknown"
	}
}

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

func ref[T any](v T) *T { return &v }

func truncate(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max]
}

// pduString / pduUint convert an SnmpPDU's typed value into the shape we need, tolerating
// SNMP's "no such object/instance" sentinels (an OID the device simply doesn't implement) as a
// zero value rather than a crash.
func pduString(pdu gosnmp.SnmpPDU) string {
	switch v := pdu.Value.(type) {
	case []byte:
		return string(v)
	case string:
		return v
	default:
		return ""
	}
}

func pduUint(pdu gosnmp.SnmpPDU) uint64 {
	switch pdu.Type {
	case gosnmp.NoSuchObject, gosnmp.NoSuchInstance, gosnmp.EndOfMibView:
		return 0
	}
	big := gosnmp.ToBigInt(pdu.Value)
	if big == nil || !big.IsUint64() {
		return 0
	}
	return big.Uint64()
}
