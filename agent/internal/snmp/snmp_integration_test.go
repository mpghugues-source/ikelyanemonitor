package snmp

import (
	"os"
	"sync"
	"testing"
	"time"

	"ikelyane-agent/internal/pollerconfig"
)

// These tests poll a REAL SNMP agent — set SNMP_TEST_TARGET (and, for the v2c/v3 cases,
// SNMP_TEST_COMMUNITY / SNMP_TEST_V3_*) to run them; skipped otherwise, the same convention the
// main app uses for its DATABASE_URL-gated integration tests.
//
// To stand one up locally (what this file was actually developed and verified against, on this
// project's own dev server):
//
//	dnf install net-snmp net-snmp-utils   # or apt install snmpd snmp
//	cat >/etc/snmp/snmpd.conf <<-EOF
//		agentAddress udp:127.0.0.1:161
//		rocommunity public 127.0.0.1
//		rouser v3user priv
//	EOF
//	net-snmp-create-v3-user -A authpass123 -a SHA -X privpass123 -x AES -ro v3user
//	systemctl start snmpd
//	SNMP_TEST_TARGET=127.0.0.1 go test ./internal/snmp/... -run RealAgent -v

func testTarget(t *testing.T) string {
	t.Helper()
	target := os.Getenv("SNMP_TEST_TARGET")
	if target == "" {
		t.Skip("SNMP_TEST_TARGET not set — see this file's doc comment to stand up a real snmpd to test against")
	}
	return target
}

func baseDevice(target string) pollerconfig.Device {
	return pollerconfig.Device{
		ID:        "dev_test",
		IPAddress: target,
		Type:      "other",
		SNMP:      pollerconfig.SNMP{Port: 161, TimeoutMs: 2000, Retries: 1},
	}
}

func TestPoll_RealAgent_V2c(t *testing.T) {
	target := testTarget(t)
	community := os.Getenv("SNMP_TEST_COMMUNITY")
	if community == "" {
		community = "public"
	}

	device := baseDevice(target)
	device.SNMP.Version = "v2c"
	device.SNMP.Community = community

	poller := New()
	now := time.Now()
	result := poller.Poll(device, now)

	if !result.Device.Reachable {
		t.Fatalf("expected the device to be reachable; got %+v", result.Device)
	}
	if result.Device.SysDescr == "" {
		t.Error("expected a non-empty sysDescr from a real agent")
	}
	if result.Device.LatencyMs == nil || *result.Device.LatencyMs < 0 {
		t.Error("expected a non-negative LatencyMs on a successful poll")
	}
	if len(result.Interfaces) == 0 {
		t.Fatal("expected at least one interface (every host has loopback)")
	}

	foundLoopback := false
	for _, iface := range result.Interfaces {
		if iface.Name == "lo" {
			foundLoopback = true
		}
		if iface.OperStatus == "" {
			t.Errorf("interface %d (%s): OperStatus must never be empty (falls back to \"unknown\")", iface.IfIndex, iface.Name)
		}
		// First poll ever for this Poller instance: no previous sample to diff against.
		if iface.InBps != 0 || iface.OutBps != 0 {
			t.Logf("interface %d (%s) already has a rate on the very first poll — should not happen with a fresh Poller", iface.IfIndex, iface.Name)
		}
	}
	if !foundLoopback {
		t.Error("expected to find the loopback interface by name \"lo\"")
	}

	// Second poll: rates are now computable (even if the actual value is legitimately 0 — a quiet
	// interface between two polls a few milliseconds apart is a real, valid outcome, not a bug).
	second := poller.Poll(device, now.Add(time.Second))
	if !second.Device.Reachable {
		t.Fatal("second poll should also succeed")
	}
	if len(second.Interfaces) != len(result.Interfaces) {
		t.Errorf("interface count changed between polls: %d then %d", len(result.Interfaces), len(second.Interfaces))
	}
}

func TestPoll_RealAgent_V3_AuthPriv(t *testing.T) {
	target := testTarget(t)
	username := envOr("SNMP_TEST_V3_USER", "v3user")
	authKey := envOr("SNMP_TEST_V3_AUTH_KEY", "authpass123")
	privKey := envOr("SNMP_TEST_V3_PRIV_KEY", "privpass123")

	device := baseDevice(target)
	device.SNMP.Version = "v3"
	device.SNMP.V3 = &pollerconfig.SNMPv3{
		Username: username, SecurityLevel: "AUTH_PRIV",
		AuthProtocol: "SHA", AuthKey: authKey,
		PrivProtocol: "AES", PrivKey: privKey,
	}

	result := New().Poll(device, time.Now())
	if !result.Device.Reachable {
		t.Fatalf("expected the SNMPv3 device to be reachable; got %+v", result.Device)
	}
	if result.Device.SysName == "" {
		t.Error("expected a non-empty sysName from a real agent over SNMPv3")
	}
}

func TestPoll_RealAgent_WrongV3Credentials_IsUnreachableNotAPanic(t *testing.T) {
	target := testTarget(t)
	device := baseDevice(target)
	device.SNMP.Version = "v3"
	device.SNMP.V3 = &pollerconfig.SNMPv3{
		Username: "v3user", SecurityLevel: "AUTH_PRIV",
		AuthProtocol: "SHA", AuthKey: "totally-wrong-passphrase",
		PrivProtocol: "AES", PrivKey: "also-wrong",
	}
	result := New().Poll(device, time.Now())
	if result.Device.Reachable {
		t.Error("a wrong SNMPv3 passphrase must be reported as unreachable, not silently accepted")
	}
}

func TestPoll_UnreachableHost_NeverPanics(t *testing.T) {
	device := baseDevice("192.0.2.1") // TEST-NET-1 (RFC 5737): reserved, guaranteed unroutable
	device.SNMP.Version = "v2c"
	device.SNMP.Community = "public"
	device.SNMP.TimeoutMs = 300
	device.SNMP.Retries = 0

	result := New().Poll(device, time.Now())
	if result.Device.Reachable {
		t.Error("192.0.2.1 must never be reachable")
	}
	if result.Device.IPAddress != "192.0.2.1" {
		t.Errorf("IPAddress = %q, want it preserved even on failure", result.Device.IPAddress)
	}
}

// TestPoll_ConcurrentCallsAreRaceFree exercises the exact pattern cmd/ikelyane-agent uses (one
// shared *Poller, several devices polled from goroutines at once) — run with -race, which is what
// actually caught the bug class this guards: Poller.prev is a plain map, and Poll used to touch it
// with no locking at all.
func TestPoll_ConcurrentCallsAreRaceFree(t *testing.T) {
	target := testTarget(t)
	device := baseDevice(target)
	device.SNMP.Version = "v2c"
	device.SNMP.Community = "public"

	poller := New()
	const goroutines = 8
	var wg sync.WaitGroup
	for i := 0; i < goroutines; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 3; j++ {
				poller.Poll(device, time.Now())
			}
		}()
	}
	wg.Wait()
}

func envOr(name, fallback string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return fallback
}
