package telemetry

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strconv"
	"strings"
	"time"
)

// Sign returns the value of the X-Ikelyane-Signature header for body, signed with secret at t.
//
// Per docs/telemetry.md:
//
//	v1 = hex(HMAC-SHA256(key = secret's UTF-8 bytes, message = "<unix seconds>." + <exact body bytes>))
//
// The caller must sign the EXACT bytes it is about to send — never re-serialize after signing.
func Sign(secret string, body []byte, t time.Time) string {
	mac := hmac.New(sha256.New, []byte(secret))
	fmt.Fprintf(mac, "%d.", t.Unix())
	mac.Write(body)
	return fmt.Sprintf("t=%d,v1=%s", t.Unix(), hex.EncodeToString(mac.Sum(nil)))
}

// VerifyResponse checks the X-Ikelyane-Signature header the server puts on responses the agent must
// trust (remediation jobs): same "t=<unix>,v1=<hex>[,v1=…]" format and HMAC as requests, computed with
// this host's secret over the exact response body. Any one v1 matching is enough (the server sends one
// per valid secret during a rotation). The timestamp must be within maxSkew of now, so a captured
// response cannot be replayed later.
func VerifyResponse(secret, header string, body []byte, now time.Time, maxSkew time.Duration) error {
	var t int64
	var sigs [][]byte
	for _, part := range strings.Split(header, ",") {
		key, value, ok := strings.Cut(strings.TrimSpace(part), "=")
		if !ok {
			continue
		}
		switch key {
		case "t":
			parsed, err := strconv.ParseInt(value, 10, 64)
			if err != nil {
				return fmt.Errorf("malformed signature timestamp")
			}
			t = parsed
		case "v1":
			if sig, err := hex.DecodeString(value); err == nil && len(sig) == sha256.Size {
				sigs = append(sigs, sig)
			}
		}
	}
	if t == 0 || len(sigs) == 0 {
		return fmt.Errorf("missing or malformed response signature")
	}
	if skew := now.Sub(time.Unix(t, 0)); skew > maxSkew || skew < -maxSkew {
		return fmt.Errorf("response signature timestamp is %s away from local time", skew.Round(time.Second))
	}
	mac := hmac.New(sha256.New, []byte(secret))
	fmt.Fprintf(mac, "%d.", t)
	mac.Write(body)
	expected := mac.Sum(nil)
	for _, sig := range sigs {
		if hmac.Equal(sig, expected) {
			return nil
		}
	}
	return fmt.Errorf("response signature does not match this host's secret")
}
