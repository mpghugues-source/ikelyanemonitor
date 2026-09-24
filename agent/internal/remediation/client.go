package remediation

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"ikelyane-agent/internal/telemetry"
)

// Client talks to /api/v1/remediation/*, signed like telemetry. Responses carrying a job must be
// signed by the platform with this host's secret, or the job is ignored.
type Client struct {
	ServerURL string
	KeyID     string
	Secret    string
	HTTP      *http.Client
	// MaxSkew bounds how old a signed response may be (default 5 minutes, like the server's window).
	MaxSkew time.Duration
}

func NewClient(serverURL, keyID, secret string) *Client {
	return &Client{ServerURL: serverURL, KeyID: keyID, Secret: secret, HTTP: &http.Client{Timeout: 30 * time.Second}, MaxSkew: 5 * time.Minute}
}

// A job is at most a 64 KiB script plus small metadata; JSON escaping can grow it a few times.
const maxJobResponse = 1 << 20

// Next fetches the next job for this host, or nil when there is none.
func (c *Client) Next() (*Job, error) {
	req, err := http.NewRequest(http.MethodGet, c.ServerURL+"/api/v1/remediation/next", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("X-Ikelyane-Key-Id", c.KeyID)
	req.Header.Set("X-Ikelyane-Signature", telemetry.Sign(c.Secret, nil, time.Now()))
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxJobResponse+1))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("remediation/next: HTTP %d", resp.StatusCode)
	}
	if len(body) > maxJobResponse {
		return nil, fmt.Errorf("remediation/next: response too large")
	}
	if err := telemetry.VerifyResponse(c.Secret, resp.Header.Get("X-Ikelyane-Signature"), body, time.Now(), c.MaxSkew); err != nil {
		return nil, fmt.Errorf("remediation/next: refusing unverified response: %w", err)
	}
	var parsed struct {
		Execution *Job `json:"execution"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		return nil, fmt.Errorf("remediation/next: %w", err)
	}
	return parsed.Execution, nil
}

// Report sends a result. 409 means the platform no longer considers it running (timed out on its
// side, or already reported): nothing to retry.
func (c *Client) Report(result Result) error {
	body, err := json.Marshal(result)
	if err != nil {
		return err
	}
	req, err := http.NewRequest(http.MethodPost, c.ServerURL+"/api/v1/remediation/result", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Ikelyane-Key-Id", c.KeyID)
	req.Header.Set("X-Ikelyane-Signature", telemetry.Sign(c.Secret, body, time.Now()))
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64*1024))
	if resp.StatusCode == http.StatusOK || resp.StatusCode == http.StatusConflict {
		return nil
	}
	return fmt.Errorf("remediation/result: HTTP %d", resp.StatusCode)
}
