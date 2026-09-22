package collect

import (
	"context"
	"testing"
	"time"
)

func TestRate(t *testing.T) {
	cases := []struct {
		name      string
		cur, prev uint64
		seconds   float64
		want      float64
	}{
		{"normal increase", 1100, 1000, 10, 10},
		{"no time elapsed", 1100, 1000, 0, 0},
		{"counter reset (device replaced)", 5, 1000, 10, 0},
		{"no change", 1000, 1000, 10, 0},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := rate(c.cur, c.prev, c.seconds); got != c.want {
				t.Errorf("rate(%d, %d, %v) = %v, want %v", c.cur, c.prev, c.seconds, got, c.want)
			}
		})
	}
}

func TestClampPercent(t *testing.T) {
	cases := map[float64]float64{-5: 0, 0: 0, 50: 50, 100: 100, 137: 100}
	for in, want := range cases {
		if got := clampPercent(in); got != want {
			t.Errorf("clampPercent(%v) = %v, want %v", in, got, want)
		}
	}
}

func TestOSFamily(t *testing.T) {
	cases := map[string]string{
		"linux":   "linux",
		"windows": "windows",
		"darwin":  "macos",
		"freebsd": "unix",
		"solaris": "unix",
		"plan9":   "other",
	}
	for goos, want := range cases {
		if got := osFamily(goos); got != want {
			t.Errorf("osFamily(%q) = %q, want %q", goos, got, want)
		}
	}
}

func TestDeviceName(t *testing.T) {
	cases := map[string]string{
		"nvme0n1":            "nvme0n1",
		"/dev/sda1":          "sda1",
		`\\.\PhysicalDrive0`: "PhysicalDrive0",
	}
	for in, want := range cases {
		if got := deviceName(in); got != want {
			t.Errorf("deviceName(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestIsLoopbackName(t *testing.T) {
	for _, name := range []string{"lo", "lo0"} {
		if !isLoopbackName(name) {
			t.Errorf("isLoopbackName(%q) = false, want true", name)
		}
	}
	for _, name := range []string{"eth0", "en0", "wlan0"} {
		if isLoopbackName(name) {
			t.Errorf("isLoopbackName(%q) = true, want false", name)
		}
	}
}

func TestIsVirtualInterfaceName(t *testing.T) {
	// Regression: this exact set (minus eth0) is what a real run on this project's own Docker host
	// reported before the filter existed — see the comment on virtualInterfacePrefixes.
	virtual := []string{"docker0", "br-72a8e60e2c94", "veth2418d7d", "virbr0", "vnet3", "cni0", "flannel.1", "kube-bridge", "cali1234abcd", "tap0", "tun0"}
	for _, name := range virtual {
		if !isVirtualInterfaceName(name) {
			t.Errorf("isVirtualInterfaceName(%q) = false, want true", name)
		}
	}
	real := []string{"eth0", "en0", "wlan0", "enp3s0", "ens160"}
	for _, name := range real {
		if isVirtualInterfaceName(name) {
			t.Errorf("isVirtualInterfaceName(%q) = true, want false (a real NIC must never be filtered)", name)
		}
	}
}

// TestCollect_OnThisMachine is a smoke test against whatever machine actually runs `go test`
// (this repo's own dev server): it exercises the real gopsutil calls end to end and checks the
// output is shaped the way the server expects, rather than mocking every syscall.
func TestCollect_OnThisMachine(t *testing.T) {
	if testing.Short() {
		t.Skip("samples real CPU usage over 1s; skipped with -short")
	}
	c := New("test")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	sys, warnings := c.Collect(ctx)
	for _, w := range warnings {
		t.Logf("collection warning (non-fatal): %v", w)
	}

	if sys.CollectedAt == "" {
		t.Error("CollectedAt must always be set")
	}
	if _, err := time.Parse(time.RFC3339, sys.CollectedAt); err != nil {
		t.Errorf("CollectedAt %q is not RFC3339: %v", sys.CollectedAt, err)
	}
	if sys.Inventory == nil {
		t.Error("the first Collect() call must include inventory")
	} else if sys.Inventory.OSFamily != "linux" {
		t.Errorf("OSFamily = %q, want linux (this test runs on a Linux CI/dev box)", sys.Inventory.OSFamily)
	}
	if sys.CPU == nil {
		t.Error("CPU metrics should be available on this machine")
	} else if sys.CPU.UsagePercent < 0 || sys.CPU.UsagePercent > 100 {
		t.Errorf("CPU.UsagePercent = %v, want 0..100", sys.CPU.UsagePercent)
	}
	if sys.Memory == nil || sys.Memory.UsedPercent == nil {
		t.Error("memory usage should be available on this machine")
	}
	if len(sys.Disks) == 0 {
		t.Error("expected at least one mounted filesystem (this is a real server, not a container with no disks)")
	}
	for _, d := range sys.Disks {
		if d.ReadIops != nil || d.WriteIops != nil {
			t.Errorf("disk %q: rates must be nil on the very first sample (nothing to compare against yet)", d.Mount)
		}
	}

	// Second call: rates should now be populated, since there is a previous sample to diff against.
	time.Sleep(1100 * time.Millisecond)
	sys2, _ := c.Collect(ctx)
	if sys2.Inventory != nil {
		t.Error("inventory should NOT be resent on the very next call (inventoryEvery has not elapsed)")
	}
	foundRate := false
	for _, d := range sys2.Disks {
		if d.ReadIops != nil {
			foundRate = true
		}
	}
	if !foundRate && len(sys2.Disks) > 0 {
		t.Log("no disk reported a rate on the second sample — acceptable if this filesystem truly saw zero I/O, but worth a look if it happens often")
	}
}
