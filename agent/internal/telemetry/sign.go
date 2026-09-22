package telemetry

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
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
