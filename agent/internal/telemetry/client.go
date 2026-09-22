package telemetry

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// Outcome classifies a Send() result the way docs/telemetry.md's response table does, so callers
// know whether the batch is worth keeping for a retry.
type Outcome int

const (
	// OutcomeStored means the server accepted (or already had, idempotently) the batch: drop it.
	OutcomeStored Outcome = iota
	// OutcomeRetry means a network error or 5xx: keep the batch and retry later.
	OutcomeRetry
	// OutcomeBug means the request itself is malformed or misconfigured (400/401 except clock skew/413/422):
	// retrying the SAME bytes would never succeed, so the batch should be dropped, loudly.
	OutcomeBug
	// OutcomeClockSkew means the server rejected the timestamp: the agent's clock needs fixing.
	// The exact request is now stale (its signature window has likely passed by the time anyone
	// notices), so it is not worth keeping — the next cycle builds a fresh one.
	OutcomeClockSkew
	// OutcomeHostDisabled means the host was switched off in IkelyaneMonitor: stop sending until
	// an operator re-enables it. The batch is dropped rather than buffered indefinitely.
	OutcomeHostDisabled
)

func (o Outcome) String() string {
	switch o {
	case OutcomeStored:
		return "stored"
	case OutcomeRetry:
		return "retry"
	case OutcomeBug:
		return "bug"
	case OutcomeClockSkew:
		return "clock_skew"
	case OutcomeHostDisabled:
		return "host_disabled"
	default:
		return "unknown"
	}
}

type errorResponse struct {
	Error struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

// Result is what one Send() attempt produced.
type Result struct {
	Outcome    Outcome
	StatusCode int
	ErrorCode  string
	Message    string
}

// Client sends already-serialized telemetry bodies to one IkelyaneMonitor server.
type Client struct {
	ServerURL string
	KeyID     string
	Secret    string
	HTTP      *http.Client
}

func NewClient(serverURL, keyID, secret string) *Client {
	return &Client{
		ServerURL: serverURL,
		KeyID:     keyID,
		Secret:    secret,
		HTTP:      &http.Client{Timeout: 30 * time.Second},
	}
}

// maxResponseBody bounds how much of an error response we read; the server never sends more than
// a few KiB here, and a hostile or misconfigured endpoint must not make the agent buffer unbounded data.
const maxResponseBody = 64 * 1024

// Send POSTs body (bytes already built by the caller — never re-serialized here) with a FRESH
// signature timestamped at call time. This is what lets a buffered payload, collected minutes or
// hours ago, still be sent successfully later: only `t` (and therefore the signature) needs to be
// current, not the metrics' own `collectedAt` inside the body.
func (c *Client) Send(body []byte) Result {
	req, err := http.NewRequest(http.MethodPost, c.ServerURL+"/api/v1/telemetry", bytes.NewReader(body))
	if err != nil {
		return Result{Outcome: OutcomeRetry, Message: err.Error()}
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Ikelyane-Key-Id", c.KeyID)
	req.Header.Set("X-Ikelyane-Signature", Sign(c.Secret, body, time.Now()))

	resp, err := c.HTTP.Do(req)
	if err != nil {
		return Result{Outcome: OutcomeRetry, Message: err.Error()}
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(io.LimitReader(resp.Body, maxResponseBody))

	if resp.StatusCode == http.StatusOK {
		return Result{Outcome: OutcomeStored, StatusCode: resp.StatusCode}
	}

	var parsed errorResponse
	_ = json.Unmarshal(respBody, &parsed) // best-effort: an unparsable error body still has a status code

	result := Result{StatusCode: resp.StatusCode, ErrorCode: parsed.Error.Code, Message: parsed.Error.Message}
	if result.Message == "" {
		result.Message = fmt.Sprintf("HTTP %d", resp.StatusCode)
	}

	switch {
	case resp.StatusCode == http.StatusForbidden && parsed.Error.Code == "host_disabled":
		result.Outcome = OutcomeHostDisabled
	case resp.StatusCode == http.StatusUnauthorized && parsed.Error.Code == "timestamp_out_of_tolerance":
		result.Outcome = OutcomeClockSkew
	case resp.StatusCode >= 500:
		result.Outcome = OutcomeRetry
	default:
		result.Outcome = OutcomeBug
	}
	return result
}
