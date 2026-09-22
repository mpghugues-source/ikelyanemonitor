package snmp

import (
	"strconv"
	"strings"
)

// Standard MIB-II / IF-MIB / EtherLike-MIB OIDs. No vendor-specific (ENTITY-MIB, hardware sensor)
// OIDs here — see the package doc comment for what that trades off.
const (
	oidSysDescr  = ".1.3.6.1.2.1.1.1.0"
	oidSysUpTime = ".1.3.6.1.2.1.1.3.0"
	oidSysName   = ".1.3.6.1.2.1.1.5.0"

	// ifTable (RFC 1213): column.ifIndex, walked whole and demultiplexed by column below.
	oidIfTable       = ".1.3.6.1.2.1.2.2.1"
	colIfDescr       = 2
	colIfSpeed       = 5
	colIfAdminStatus = 7
	colIfOperStatus  = 8
	colIfInOctets    = 10
	colIfInDiscards  = 13
	colIfInErrors    = 14
	colIfOutOctets   = 16
	colIfOutDiscards = 19
	colIfOutErrors   = 20

	// ifXTable (RFC 2233/2863): 64-bit counters and better naming, not guaranteed on old devices.
	oidIfXTable      = ".1.3.6.1.2.1.31.1.1.1"
	colIfName        = 1
	colIfHCInOctets  = 6
	colIfHCOutOctets = 10
	colIfHighSpeed   = 15
	colIfAlias       = 18

	// dot3StatsFCSErrors (EtherLike-MIB, RFC 3635) — CRC errors. Best-effort: only Ethernet-like
	// ports implement this table, and its index does not always equal ifIndex, but commonly does.
	oidDot3StatsFCSErrors = ".1.3.6.1.2.1.10.7.2.1.3"
)

// tableIndex extracts the trailing "<column>.<index>" from a walked OID like
// ".1.3.6.1.2.1.2.2.1.10.5" given its table base ".1.3.6.1.2.1.2.2.1": returns (10, 5, true).
func tableIndex(oid, base string) (column, index int, ok bool) {
	if !strings.HasPrefix(oid, base+".") {
		return 0, 0, false
	}
	rest := strings.TrimPrefix(oid, base+".")
	parts := strings.SplitN(rest, ".", 2)
	if len(parts) != 2 {
		return 0, 0, false
	}
	column, err1 := strconv.Atoi(parts[0])
	index, err2 := strconv.Atoi(parts[1])
	if err1 != nil || err2 != nil {
		return 0, 0, false
	}
	return column, index, true
}

// singleIndex extracts the trailing index from a single-column table OID like
// ".1.3.6.1.2.1.10.7.2.1.3.5" given its column base ".1.3.6.1.2.1.10.7.2.1.3": returns (5, true).
func singleIndex(oid, base string) (index int, ok bool) {
	if !strings.HasPrefix(oid, base+".") {
		return 0, false
	}
	index, err := strconv.Atoi(strings.TrimPrefix(oid, base+"."))
	return index, err == nil
}
