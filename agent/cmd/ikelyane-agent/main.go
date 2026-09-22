// Command ikelyane-agent collects host metrics and reports them to an IkelyaneMonitor server.
// Protocol: docs/telemetry.md in the main repository. Usage: see README.md.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"ikelyane-agent/internal/buffer"
	"ikelyane-agent/internal/collect"
	"ikelyane-agent/internal/config"
	"ikelyane-agent/internal/pollerconfig"
	"ikelyane-agent/internal/snmp"
	"ikelyane-agent/internal/telemetry"
)

// Version is overridden at build time: go build -ldflags "-X main.Version=1.2.3".
var Version = "0.1.0-dev"

// bufferFlushBatch caps how many buffered payloads are retried in a single cycle, so a huge
// backlog after a long outage cannot make one cycle run for an unbounded amount of time.
const bufferFlushBatch = 20

// pollerConfigRefreshEvery bounds how often the assigned-devices list is re-fetched from the
// server: devices added/removed/reassigned in the web UI take up to this long to be picked up
// (there is no push notification — see docs/telemetry.md "Discovering SNMP targets").
const pollerConfigRefreshEvery = 5 * time.Minute

// snmpState carries the SNMP side across cycles: the last-known device assignment (kept on a
// failed refresh rather than cleared, so a transient config-fetch error doesn't stop polling
// devices the agent already knew about) and the counter-delta state for rate calculation.
type snmpState struct {
	client      *pollerconfig.Client
	poller      *snmp.Poller
	devices     []pollerconfig.Device
	lastFetched time.Time
}

func newSNMPState(cfg *config.Config) *snmpState {
	return &snmpState{client: pollerconfig.NewClient(cfg.ServerURL, cfg.KeyID, cfg.Secret), poller: snmp.New()}
}

func (s *snmpState) refresh(now time.Time) {
	if !s.lastFetched.IsZero() && now.Sub(s.lastFetched) < pollerConfigRefreshEvery {
		return
	}
	cfg, err := s.client.Fetch()
	if err != nil {
		log.Printf("could not fetch SNMP device assignment: %v (keeping the last known list, %d device(s))", err, len(s.devices))
		return
	}
	if len(cfg.Devices) != len(s.devices) {
		log.Printf("SNMP device assignment: %d device(s)", len(cfg.Devices))
	}
	s.devices = cfg.Devices
	s.lastFetched = now
}

// snmpPollConcurrency bounds how many devices are polled at once: sequential polling of a large
// assignment (each device timing out on its own schedule when unreachable) could otherwise make
// one cycle take far longer than the collection interval. snmp.Poller is safe for this.
const snmpPollConcurrency = 10

func (s *snmpState) pollAll(now time.Time) []telemetry.SnmpDevice {
	if len(s.devices) == 0 {
		return nil
	}
	results := make([]telemetry.SnmpDevice, len(s.devices))
	sem := make(chan struct{}, snmpPollConcurrency)
	var wg sync.WaitGroup
	for i, device := range s.devices {
		wg.Add(1)
		sem <- struct{}{}
		go func(i int, device pollerconfig.Device) {
			defer wg.Done()
			defer func() { <-sem }()
			result := s.poller.Poll(device, now)
			if !result.Device.Reachable {
				log.Printf("SNMP device %s: unreachable", device.IPAddress)
			}
			results[i] = result
		}(i, device)
	}
	wg.Wait()
	return results
}

func main() {
	configPath := flag.String("config", "", "path to a JSON config file (default: read IKELYANE_* environment variables)")
	once := flag.Bool("once", false, "collect and send a single sample, then exit (useful for testing)")
	printVersion := flag.Bool("version", false, "print the version and exit")
	flag.Parse()

	if *printVersion {
		fmt.Println(Version)
		return
	}

	cfg, err := config.Load(*configPath)
	if err != nil {
		log.Fatalf("configuration error: %v", err)
	}

	buf, err := buffer.New(cfg.BufferDir)
	if err != nil {
		log.Fatalf("buffer error: %v", err)
	}

	client := telemetry.NewClient(cfg.ServerURL, cfg.KeyID, cfg.Secret)
	collector := collect.New(Version)
	snmpSt := newSNMPState(cfg)

	log.Printf("ikelyane-agent %s starting: server=%s interval=%s buffer=%s", Version, cfg.ServerURL, cfg.Interval, cfg.BufferDir)

	if *once {
		runCycle(collector, client, buf, snmpSt)
		return
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	ticker := time.NewTicker(cfg.Interval)
	defer ticker.Stop()

	runCycle(collector, client, buf, snmpSt) // first sample immediately, don't wait a full interval
	for {
		select {
		case <-ctx.Done():
			log.Println("shutting down")
			return
		case <-ticker.C:
			runCycle(collector, client, buf, snmpSt)
		}
	}
}

// runCycle flushes whatever is buffered, then collects and sends a fresh sample. A single cycle's
// failures never crash the agent: everything here is logged and retried on the next tick.
func runCycle(collector *collect.Collector, client *telemetry.Client, buf *buffer.Buffer, snmpSt *snmpState) {
	flushBuffer(client, buf)

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	sys, warnings := collector.Collect(ctx)
	for _, w := range warnings {
		log.Printf("collection warning: %v", w)
	}

	now := time.Now()
	snmpSt.refresh(now)
	snmpDevices := snmpSt.pollAll(now)

	payload := telemetry.Payload{
		SchemaVersion: telemetry.SchemaVersion,
		SentAt:        now.UTC().Format(time.RFC3339),
		Agent:         telemetry.AgentInfo{Version: Version},
		System:        sys,
		SNMPDevices:   snmpDevices,
	}
	body, err := json.Marshal(payload)
	if err != nil {
		log.Printf("BUG: could not encode payload: %v", err)
		return
	}

	sendOrBuffer(client, buf, body, "this sample")
}

// flushBuffer retries buffered payloads oldest-first. It stops at the first retry-worthy failure
// (server unreachable / 5xx): trying the rest would just fail the same way and delay the fresh
// sample below. A payload that will never succeed as-is (a bug/misconfiguration response) is
// dropped immediately instead, since retrying identical bytes cannot change the outcome.
func flushBuffer(client *telemetry.Client, buf *buffer.Buffer) {
	entries, err := buf.Pending()
	if err != nil {
		log.Printf("could not read buffer: %v", err)
		return
	}
	if len(entries) == 0 {
		return
	}
	log.Printf("replaying %d buffered payload(s)", len(entries))

	for i, e := range entries {
		if i >= bufferFlushBatch {
			log.Printf("%d buffered payload(s) left for the next cycle", len(entries)-i)
			break
		}
		result := client.Send(e.Body)
		switch result.Outcome {
		case telemetry.OutcomeStored:
			if err := buf.Remove(e.Path); err != nil {
				log.Printf("sent buffered payload but could not remove it from disk: %v", err)
			}
		case telemetry.OutcomeRetry:
			log.Printf("still unreachable (%s): keeping %d buffered payload(s) for later", result.Message, len(entries)-i)
			return
		default:
			log.Printf("dropping a buffered payload (%s: %s) — resending the same bytes would fail the same way", result.Outcome, result.Message)
			_ = buf.Remove(e.Path)
		}
	}
}

func sendOrBuffer(client *telemetry.Client, buf *buffer.Buffer, body []byte, label string) {
	result := client.Send(body)
	switch result.Outcome {
	case telemetry.OutcomeStored:
		log.Printf("sent %s", label)
	case telemetry.OutcomeRetry:
		log.Printf("could not send %s (%s), buffering for retry", label, result.Message)
		if err := buf.Push(body); err != nil {
			log.Printf("could not buffer %s: %v", label, err)
		}
	case telemetry.OutcomeClockSkew:
		log.Printf("server rejected %s: clock skew too large (%s) — check NTP on this host", label, result.Message)
	case telemetry.OutcomeHostDisabled:
		log.Printf("this host is disabled in IkelyaneMonitor: %s", result.Message)
	case telemetry.OutcomeBug:
		log.Printf("server rejected %s as invalid (%s: %s) — this needs a configuration or agent fix, not a retry", label, result.ErrorCode, result.Message)
	}
}
