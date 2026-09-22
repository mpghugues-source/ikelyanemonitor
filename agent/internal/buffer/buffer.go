// Package buffer implements a small disk-backed queue of unsent telemetry payloads, used while the
// server is unreachable (docs/telemetry.md, "Delivery semantics"). Points are idempotent on the
// server (keyed by source+metric+instance+time), so re-sending a buffered payload later — even
// re-signed with a fresh timestamp — is always safe.
package buffer

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"time"
)

// MaxEntries bounds how many payloads accumulate during a long outage. At a 60s collection
// interval this is a bit over 8 hours; older entries are dropped (oldest first) to make room
// rather than growing the buffer without limit.
const MaxEntries = 500

// MaxAge mirrors the server's TELEMETRY_MAX_BACKFILL_DAYS default: a point older than this would
// be refused anyway (timestamp_out_of_range), so there is no reason to keep trying to send it.
const MaxAge = 7 * 24 * time.Hour

const filePrefix = "payload-"
const fileSuffix = ".json"

type Buffer struct {
	dir string
}

func New(dir string) (*Buffer, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("creating buffer directory: %w", err)
	}
	return &Buffer{dir: dir}, nil
}

// Entry is one buffered payload, ready to be re-signed and sent.
type Entry struct {
	Path string
	Body []byte
}

// Push saves body for later. Filenames sort chronologically (RFC3339Nano has no ambiguous
// ordering issues, unlike a raw Unix timestamp colliding within the same second), so Pending()
// can replay oldest-first with nothing fancier than a sorted directory listing.
func (b *Buffer) Push(body []byte) error {
	if err := b.evictIfFull(); err != nil {
		return err
	}
	name := filePrefix + time.Now().UTC().Format("20060102T150405.000000000Z") + fileSuffix
	path := filepath.Join(b.dir, name)
	// 0600: payloads are metrics, not secrets, but there is no reason to make them world-readable.
	if err := os.WriteFile(path, body, 0o600); err != nil {
		return fmt.Errorf("writing buffered payload: %w", err)
	}
	return nil
}

// Pending returns every still-usable buffered payload, oldest first, pruning (and permanently
// dropping) anything past MaxAge along the way.
func (b *Buffer) Pending() ([]Entry, error) {
	files, err := os.ReadDir(b.dir)
	if err != nil {
		return nil, fmt.Errorf("listing buffer directory: %w", err)
	}
	names := make([]string, 0, len(files))
	for _, f := range files {
		if !f.IsDir() && len(f.Name()) > len(filePrefix)+len(fileSuffix) {
			names = append(names, f.Name())
		}
	}
	sort.Strings(names) // the timestamp-based names sort chronologically

	cutoff := time.Now().Add(-MaxAge)
	entries := make([]Entry, 0, len(names))
	for _, name := range names {
		path := filepath.Join(b.dir, name)
		info, err := os.Stat(path)
		if err != nil {
			continue // raced with a concurrent removal; not our problem
		}
		if info.ModTime().Before(cutoff) {
			_ = os.Remove(path)
			continue
		}
		body, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		entries = append(entries, Entry{Path: path, Body: body})
	}
	return entries, nil
}

// Remove deletes a buffered payload, normally called after it was sent successfully.
func (b *Buffer) Remove(path string) error {
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

// evictIfFull drops the OLDEST entries once the buffer is at capacity, making room for the new one.
func (b *Buffer) evictIfFull() error {
	files, err := os.ReadDir(b.dir)
	if err != nil {
		return fmt.Errorf("listing buffer directory: %w", err)
	}
	if len(files) < MaxEntries {
		return nil
	}
	names := make([]string, 0, len(files))
	for _, f := range files {
		if !f.IsDir() {
			names = append(names, f.Name())
		}
	}
	sort.Strings(names)
	toDrop := len(names) - MaxEntries + 1
	for i := 0; i < toDrop && i < len(names); i++ {
		_ = os.Remove(filepath.Join(b.dir, names[i]))
	}
	return nil
}
