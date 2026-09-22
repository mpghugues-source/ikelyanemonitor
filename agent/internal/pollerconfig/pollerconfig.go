// Package pollerconfig fetches this agent's assigned SNMP devices (with decrypted credentials)
// from GET /api/v1/poller-config — see docs/telemetry.md "Discovering SNMP targets".
package pollerconfig

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"ikelyane-agent/internal/telemetry"
)

// SNMPv3 holds USM parameters, present only when Device.Version == "v3".
type SNMPv3 struct {
	Username      string `json:"username"`
	SecurityLevel string `json:"securityLevel"` // NO_AUTH_NO_PRIV | AUTH_NO_PRIV | AUTH_PRIV
	AuthProtocol  string `json:"authProtocol"`  // MD5 | SHA | SHA224 | SHA256 | SHA384 | SHA512
	AuthKey       string `json:"authKey"`
	PrivProtocol  string `json:"privProtocol"` // DES | AES | AES192 | AES256
	PrivKey       string `json:"privKey"`
	ContextName   string `json:"contextName"`
}

type SNMP struct {
	Version   string  `json:"version"` // v1 | v2c | v3
	Port      int     `json:"port"`
	TimeoutMs int     `json:"timeoutMs"`
	Retries   int     `json:"retries"`
	Community string  `json:"community"` // v1/v2c only
	V3        *SNMPv3 `json:"v3"`
}

type Device struct {
	ID              string `json:"id"`
	IPAddress       string `json:"ipAddress"`
	Type            string `json:"type"`
	PollIntervalSec int    `json:"pollIntervalSec"`
	SNMP            SNMP   `json:"snmp"`
}

type Config struct {
	Devices []Device `json:"devices"`
}

type errorResponse struct {
	Error struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

type Client struct {
	ServerURL string
	KeyID     string
	Secret    string
	HTTP      *http.Client
}

func NewClient(serverURL, keyID, secret string) *Client {
	return &Client{ServerURL: serverURL, KeyID: keyID, Secret: secret, HTTP: &http.Client{Timeout: 30 * time.Second}}
}

const maxResponseBody = 1 << 20 // devices carry no user-controlled free text of any size; 1 MiB is generous

// Fetch retrieves the current device assignment. Signed exactly like telemetry.Client.Send, but
// over an empty body (a GET has none) — see telemetry.Sign and docs/telemetry.md.
func (c *Client) Fetch() (*Config, error) {
	req, err := http.NewRequest(http.MethodGet, c.ServerURL+"/api/v1/poller-config", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("X-Ikelyane-Key-Id", c.KeyID)
	req.Header.Set("X-Ikelyane-Signature", telemetry.Sign(c.Secret, nil, time.Now()))

	resp, err := c.HTTP.Do(req)
	if err != nil {
		return nil, fmt.Errorf("poller-config request: %w", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, maxResponseBody))

	if resp.StatusCode != http.StatusOK {
		var parsed errorResponse
		_ = json.Unmarshal(body, &parsed)
		if parsed.Error.Code != "" {
			return nil, fmt.Errorf("poller-config: %s: %s", parsed.Error.Code, parsed.Error.Message)
		}
		return nil, fmt.Errorf("poller-config: HTTP %d", resp.StatusCode)
	}

	var cfg Config
	if err := json.Unmarshal(body, &cfg); err != nil {
		return nil, fmt.Errorf("poller-config: decoding response: %w", err)
	}
	return &cfg, nil
}
