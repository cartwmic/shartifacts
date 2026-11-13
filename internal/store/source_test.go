package store

import (
	"os"
	"path/filepath"
	"testing"
)

// A data directory written before sources existed opens, and its pages list with no source.
func TestSourceMigration(t *testing.T) {
	dir := t.TempDir()
	old := `{"id":"0123456789ab","created_at":"2026-01-02T03:04:05Z","tags":["old"],"revisions":[{"version":1,"title":"Old page","kind":"markdown","content":"# Old","created_at":"2026-01-02T03:04:05Z"}]}`
	if e := os.WriteFile(filepath.Join(dir, "0123456789ab.json"), []byte(old), 0600); e != nil {
		t.Fatal(e)
	}
	s, e := Open(dir)
	if e != nil {
		t.Fatal(e)
	}
	list := s.List(IncludeArchived)
	if len(list) != 1 || list[0].Title != "Old page" || list[0].Source != nil {
		t.Fatalf("%+v", list)
	}
	// Changing it keeps source null and loses nothing.
	a, e := s.Save("0123456789ab", Input{Content: "# New", BaseVersion: 1, Source: &Source{Origin: "x", Thread: "y"}})
	if e != nil || a.Source != nil || len(a.Revisions) != 2 || a.Tags[0] != "old" {
		t.Fatal(e, a)
	}
	again, e := Open(dir)
	if e != nil {
		t.Fatal(e)
	}
	if l := again.List(IncludeArchived); len(l) != 1 || l[0].Version != 2 || l[0].Source != nil {
		t.Fatalf("%+v", l)
	}
}
