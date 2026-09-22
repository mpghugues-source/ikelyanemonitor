package snmp

import "testing"

func TestTableIndex(t *testing.T) {
	col, idx, ok := tableIndex(".1.3.6.1.2.1.2.2.1.10.5", oidIfTable)
	if !ok || col != 10 || idx != 5 {
		t.Errorf("got (%d, %d, %v), want (10, 5, true)", col, idx, ok)
	}

	if _, _, ok := tableIndex(".1.3.6.1.2.1.1.1.0", oidIfTable); ok {
		t.Error("an OID outside the table base must not match")
	}
	if _, _, ok := tableIndex(oidIfTable, oidIfTable); ok {
		t.Error("the bare base OID with nothing appended must not match")
	}
	if _, _, ok := tableIndex(oidIfTable+".10.not-a-number", oidIfTable); ok {
		t.Error("a non-numeric index must not match")
	}
}

func TestSingleIndex(t *testing.T) {
	idx, ok := singleIndex(".1.3.6.1.2.1.10.7.2.1.3.7", oidDot3StatsFCSErrors)
	if !ok || idx != 7 {
		t.Errorf("got (%d, %v), want (7, true)", idx, ok)
	}
	if _, ok := singleIndex(".1.3.6.1.2.1.1.1.0", oidDot3StatsFCSErrors); ok {
		t.Error("an OID outside the base must not match")
	}
}

func TestIfStatusString(t *testing.T) {
	cases := map[int]string{1: "up", 2: "down", 3: "testing", 4: "unknown", 5: "unknown", 0: "unknown", -1: "unknown"}
	for in, want := range cases {
		if got := ifStatusString(in); got != want {
			t.Errorf("ifStatusString(%d) = %q, want %q", in, got, want)
		}
	}
}

func TestSnmpRate(t *testing.T) {
	if got := rate(1100, 1000, 10); got != 10 {
		t.Errorf("rate = %v, want 10", got)
	}
	if got := rate(5, 1000, 10); got != 0 {
		t.Errorf("a counter reset (5 < 1000) must yield 0, got %v", got)
	}
	if got := rate(1000, 1000, 0); got != 0 {
		t.Errorf("zero elapsed time must yield 0, got %v", got)
	}
}

func TestClampPercentSnmp(t *testing.T) {
	cases := map[float64]float64{-1: 0, 0: 0, 50: 50, 100: 100, 250: 100}
	for in, want := range cases {
		if got := clampPercent(in); got != want {
			t.Errorf("clampPercent(%v) = %v, want %v", in, got, want)
		}
	}
}

func TestTruncate(t *testing.T) {
	if got := truncate("hello", 10); got != "hello" {
		t.Errorf("truncate should not pad or alter a short string, got %q", got)
	}
	if got := truncate("hello world", 5); got != "hello" {
		t.Errorf("truncate(\"hello world\", 5) = %q, want \"hello\"", got)
	}
	if got := truncate("", 5); got != "" {
		t.Errorf("truncate of empty string should stay empty, got %q", got)
	}
}
