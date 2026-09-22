package buffer

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func newTestBuffer(t *testing.T) *Buffer {
	t.Helper()
	b, err := New(t.TempDir())
	if err != nil {
		t.Fatalf("New() error: %v", err)
	}
	return b
}

func TestPushAndPending_OldestFirst(t *testing.T) {
	b := newTestBuffer(t)
	for i, body := range [][]byte{[]byte(`{"n":1}`), []byte(`{"n":2}`), []byte(`{"n":3}`)} {
		if err := b.Push(body); err != nil {
			t.Fatalf("Push(%d) error: %v", i, err)
		}
		time.Sleep(2 * time.Millisecond) // filenames carry sub-second precision; keep them distinct
	}

	entries, err := b.Pending()
	if err != nil {
		t.Fatalf("Pending() error: %v", err)
	}
	if len(entries) != 3 {
		t.Fatalf("got %d entries, want 3", len(entries))
	}
	want := []string{`{"n":1}`, `{"n":2}`, `{"n":3}`}
	for i, e := range entries {
		if string(e.Body) != want[i] {
			t.Errorf("entry %d = %s, want %s (order must be oldest first)", i, e.Body, want[i])
		}
	}
}

func TestRemove(t *testing.T) {
	b := newTestBuffer(t)
	if err := b.Push([]byte(`{"n":1}`)); err != nil {
		t.Fatal(err)
	}
	entries, _ := b.Pending()
	if len(entries) != 1 {
		t.Fatalf("got %d entries, want 1", len(entries))
	}
	if err := b.Remove(entries[0].Path); err != nil {
		t.Fatalf("Remove() error: %v", err)
	}
	entries, _ = b.Pending()
	if len(entries) != 0 {
		t.Fatalf("got %d entries after Remove, want 0", len(entries))
	}
	// Removing an already-removed entry is not an error (the caller may retry after a partial failure).
	if err := b.Remove(filepath.Join(b.dir, "does-not-exist.json")); err != nil {
		t.Fatalf("Remove() of a missing file should be a no-op, got: %v", err)
	}
}

func TestPending_PrunesEntriesOlderThanMaxAge(t *testing.T) {
	b := newTestBuffer(t)
	if err := b.Push([]byte(`{"fresh":true}`)); err != nil {
		t.Fatal(err)
	}
	stalePath := filepath.Join(b.dir, filePrefix+"19990101T000000.000000000Z"+fileSuffix)
	if err := os.WriteFile(stalePath, []byte(`{"stale":true}`), 0o600); err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-MaxAge - time.Hour)
	if err := os.Chtimes(stalePath, old, old); err != nil {
		t.Fatal(err)
	}

	entries, err := b.Pending()
	if err != nil {
		t.Fatalf("Pending() error: %v", err)
	}
	if len(entries) != 1 || string(entries[0].Body) != `{"fresh":true}` {
		t.Fatalf("got %+v, want only the fresh entry", entries)
	}
	if _, err := os.Stat(stalePath); !os.IsNotExist(err) {
		t.Fatal("the stale entry should have been deleted from disk, not just skipped")
	}
}

func TestPush_EvictsOldestWhenFull(t *testing.T) {
	b := newTestBuffer(t)
	for i := 0; i < MaxEntries+5; i++ {
		if err := b.Push([]byte(`{"n":` + string(rune('0'+i%10)) + `}`)); err != nil {
			t.Fatalf("Push(%d) error: %v", i, err)
		}
	}
	entries, err := b.Pending()
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) > MaxEntries {
		t.Fatalf("buffer holds %d entries, want at most %d", len(entries), MaxEntries)
	}
}
