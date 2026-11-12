package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/LaneBirmingham/shartifacts/internal/store"
)

// serverAt starts a server on a data folder; calling it again with the same folder is a restart.
func serverAt(t *testing.T, dir string) (*Server, http.Handler) {
	t.Helper()
	st, e := store.Open(dir)
	if e != nil {
		t.Fatal(e)
	}
	s := &Server{Store: st, Web: fstest.MapFS{"index.html": {Data: []byte("hello")}, "hub.html": {Data: []byte("apps")}}, AllowedHosts: []string{"shartifacts.example.com"}, PublicOrigin: "https://shartifacts.example.com"}
	return s, s.Handler()
}

// reach waits until the hub has recorded event n; the store announces changes asynchronously.
func reach(t *testing.T, s *Server, n int64) {
	t.Helper()
	deadline := time.After(5 * time.Second)
	for {
		_, cursor, wake, _ := s.hub.since(0, nil, nil)
		if cursor >= n {
			return
		}
		select {
		case <-wake:
		case <-deadline:
			t.Fatalf("hub stopped at event %d, want %d", cursor, n)
		}
	}
}

func watch(t *testing.T, h http.Handler, after int64) map[string]any {
	t.Helper()
	b, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": map[string]any{"name": "watch_artifacts", "arguments": map[string]any{"after": after}}})
	return mcpRequest(t, h, "http://127.0.0.1:8080", string(b))["structuredContent"].(map[string]any)
}

func seqs(events []LiveEvent) string {
	var out []string
	for _, e := range events {
		out = append(out, fmt.Sprint(e.Seq))
	}
	return strings.Join(out, ",")
}

func TestWakeCursorSurvivesRestart(t *testing.T) {
	dir := t.TempDir()
	s1, h1 := serverAt(t, dir)
	id := newPage(t, h1)
	request(h1, "POST", "/api/artifacts/"+id+"/comments", `{"body":"one"}`)
	reach(t, s1, 2)
	before := watch(t, h1, 0)
	cursor := int64(before["cursor"].(float64))
	if cursor != 2 || len(before["events"].([]any)) != 2 || before["gap"] != nil {
		t.Fatal(before)
	}

	s2, h2 := serverAt(t, dir)
	again := watch(t, h2, 0)
	if again["cursor"] != float64(2) || len(again["events"].([]any)) != 2 {
		t.Fatal("events did not survive the restart", again)
	}
	// The agent's cursor from before the restart still means something: nothing new, no gap.
	if resumed := watch(t, h2, cursor); len(resumed["events"].([]any)) != 0 || resumed["gap"] != nil || resumed["cursor"] != float64(2) {
		t.Fatal(resumed)
	}
	request(h2, "POST", "/api/artifacts/"+id+"/comments", `{"body":"two"}`)
	reach(t, s2, 3)
	next := watch(t, h2, cursor)
	ev := next["events"].([]any)
	if len(ev) != 1 || ev[0].(map[string]any)["seq"] != float64(3) || next["gap"] != nil {
		t.Fatal("seq must continue after a restart", next)
	}
}

func TestWakeCursorGap(t *testing.T) {
	path := filepath.Join(t.TempDir(), "meta", "events.jsonl")
	os.MkdirAll(filepath.Dir(path), 0700)
	var lines string
	for seq := 10; seq <= 12; seq++ {
		b, _ := json.Marshal(LiveEvent{Seq: int64(seq), Artifact: "a", Kind: "comments", At: time.Now().UTC()})
		lines += string(b) + "\n"
	}
	// A line cut short by a crash is skipped.
	os.WriteFile(path, []byte(lines+`{"seq":13,"arti`), 0600)
	h := newHub(path)
	for _, tc := range []struct {
		after int64
		gap   bool
		want  string
	}{
		{0, false, "10,11,12"}, // a first call
		{9, false, "10,11,12"}, // exactly continuous with the oldest kept event
		{10, false, "11,12"},   // a fresh cursor
		{12, false, ""},        // up to date
		{5, true, "10,11,12"},  // stale: older than the oldest kept event
		{13, true, "10,11,12"}, // from the future: the history was lost
		{9000, true, "10,11,12"},
	} {
		events, cursor, _, gap := h.since(tc.after, nil, nil)
		if gap != tc.gap || seqs(events) != tc.want || cursor != 12 {
			t.Errorf("after %d: gap %v events %q cursor %d, want gap %v events %q", tc.after, gap, seqs(events), cursor, tc.gap, tc.want)
		}
	}
}

func TestWakeCursorGapOverMCP(t *testing.T) {
	dir := t.TempDir()
	s, h := serverAt(t, dir)
	newPage(t, h)
	reach(t, s, 1)
	if r := watch(t, h, 99); r["gap"] != true || len(r["events"].([]any)) != 1 || r["cursor"] != float64(1) {
		t.Fatal("a cursor from the future must say gap", r)
	}
	// Wiped data: a new server on an empty folder is told apart from "nothing happened".
	_, empty := serverAt(t, t.TempDir())
	if r := watch(t, empty, 5); r["gap"] != true || len(r["events"].([]any)) != 0 {
		t.Fatal(r)
	}
	if r := watch(t, empty, 0); r["gap"] != nil {
		t.Fatal("a first call on an empty history is not a gap", r)
	}
}

func TestWakeCursorTornLine(t *testing.T) {
	path := filepath.Join(t.TempDir(), "events.jsonl")
	good, _ := json.Marshal(LiveEvent{Seq: 1, Artifact: "a", Kind: "version", At: time.Now().UTC()})
	os.WriteFile(path, []byte(string(good)+"\n"+`{"seq":2,"arti`), 0600)
	h := newHub(path)
	h.changed("a", "comments", "x")
	if again := newHub(path); again.seq != 2 || len(again.history) != 2 || again.history[1].Detail != "x" {
		t.Fatal("the event after a torn line was lost", again.seq, again.history)
	}
}

func TestWakeCursorOverMCPKeepsEveryEvent(t *testing.T) {
	dir := t.TempDir()
	os.MkdirAll(filepath.Join(dir, "meta"), 0700)
	var lines string
	for seq := 301; seq <= 450; seq++ {
		b, _ := json.Marshal(LiveEvent{Seq: int64(seq), Artifact: "a", Kind: "version", At: time.Now().UTC()})
		lines += string(b) + "\n"
	}
	os.WriteFile(filepath.Join(dir, "meta", "events.jsonl"), []byte(lines), 0600)
	_, h := serverAt(t, dir)
	count := func(r map[string]any) int { return len(r["events"].([]any)) }
	// A stale or future cursor gets gap and every kept event, not a page of them.
	for _, after := range []int64{5, 9000} {
		if r := watch(t, h, after); r["gap"] != true || count(r) != 150 {
			t.Fatal(after, r["gap"], count(r))
		}
	}
	// A cursor that is good gets everything after it, however many; a first call gets recent ones.
	if r := watch(t, h, 300); r["gap"] != nil || count(r) != 150 {
		t.Fatal(r["gap"], count(r))
	}
	if r := watch(t, h, 0); r["gap"] != nil || count(r) != 100 {
		t.Fatal(r["gap"], count(r))
	}
}

func TestWakeCursorKeepsLastEvents(t *testing.T) {
	path := filepath.Join(t.TempDir(), "events.jsonl")
	var lines string
	for seq := 1; seq <= keptEvents+5; seq++ {
		b, _ := json.Marshal(LiveEvent{Seq: int64(seq), Artifact: "a", Kind: "version", At: time.Now().UTC()})
		lines += string(b) + "\n"
	}
	os.WriteFile(path, []byte(lines), 0600)
	h := newHub(path)
	if len(h.history) != keptEvents || h.history[0].Seq != 6 || h.seq != keptEvents+5 {
		t.Fatal(len(h.history), h.history[0].Seq, h.seq)
	}
	b, _ := os.ReadFile(path)
	if n := strings.Count(string(b), "\n"); n != keptEvents {
		t.Fatalf("the file was not trimmed at start: %d lines", n)
	}
	h.changed("a", "version", "2")
	if h.seq != keptEvents+6 {
		t.Fatal(h.seq)
	}
	if _, _, _, gap := h.since(2, nil, nil); !gap {
		t.Fatal("a cursor behind the trimmed history must say gap")
	}
	b, _ = os.ReadFile(path)
	lines2 := strings.Split(strings.TrimSpace(string(b)), "\n")
	var last LiveEvent
	if json.Unmarshal([]byte(lines2[len(lines2)-1]), &last); last.Seq != keptEvents+6 || last.Detail != "2" {
		t.Fatal("the new event was not appended", lines2[len(lines2)-1])
	}
}
