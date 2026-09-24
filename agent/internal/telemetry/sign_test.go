package telemetry

import (
	"strings"
	"testing"
	"time"
)

// TestSign_ReferenceVector reproduces the vector pinned in docs/telemetry.md, itself produced with
// OpenSSL independently of any server or agent code:
//
//	printf '1758000000.{"schemaVersion":1}' | openssl dgst -sha256 -hmac 's3cret-value'
//	=> 07aa1d93786628978c587392dbeff781224052a62006514beac26bc3a9c0b219
func TestSign_ReferenceVector(t *testing.T) {
	body := []byte(`{"schemaVersion":1}`)
	got := Sign("s3cret-value", body, time.Unix(1758000000, 0))
	want := "t=1758000000,v1=07aa1d93786628978c587392dbeff781224052a62006514beac26bc3a9c0b219"
	if got != want {
		t.Fatalf("Sign() = %q, want %q", got, want)
	}
}

func TestSign_DifferentTimestampsProduceDifferentSignatures(t *testing.T) {
	body := []byte(`{"a":1}`)
	a := Sign("secret", body, time.Unix(1000, 0))
	b := Sign("secret", body, time.Unix(1001, 0))
	if a == b {
		t.Fatal("signatures for different timestamps must differ")
	}
}

func TestSign_DifferentBodiesProduceDifferentSignatures(t *testing.T) {
	at := time.Unix(1000, 0)
	a := Sign("secret", []byte(`{"a":1}`), at)
	b := Sign("secret", []byte(`{"a":2}`), at)
	if a == b {
		t.Fatal("signatures for different bodies must differ")
	}
}

func TestVerifyResponse(t *testing.T) {
	now := time.Unix(1_758_000_000, 0)
	body := []byte(`{"execution":null}`)
	header := Sign("s3cret", body, now)

	if err := VerifyResponse("s3cret", header, body, now.Add(30*time.Second), 5*time.Minute); err != nil {
		t.Fatalf("valid response refused: %v", err)
	}
	if err := VerifyResponse("s3cret", header, []byte(`{"execution":{"id":"x"}}`), now, 5*time.Minute); err == nil {
		t.Error("a tampered body must be refused")
	}
	if err := VerifyResponse("other", header, body, now, 5*time.Minute); err == nil {
		t.Error("a signature from another secret must be refused")
	}
	if err := VerifyResponse("s3cret", header, body, now.Add(10*time.Minute), 5*time.Minute); err == nil {
		t.Error("a replayed (stale) response must be refused")
	}
	if err := VerifyResponse("s3cret", "", body, now, 5*time.Minute); err == nil {
		t.Error("an unsigned response must be refused")
	}
	// Rotation: several v1 values, any one matching is enough.
	rotated := strings.Replace(Sign("new-secret", body, now), ",v1=", ",v1="+strings.Repeat("0", 64)+",v1=", 1)
	if err := VerifyResponse("new-secret", rotated, body, now, 5*time.Minute); err != nil {
		t.Errorf("multi-signature header refused: %v", err)
	}
}
