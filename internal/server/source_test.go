package server

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/LaneBirmingham/shartifacts/internal/store"
)

func sourceServer(t *testing.T, require bool) http.Handler {
	t.Helper()
	st, e := store.Open(t.TempDir())
	if e != nil {
		t.Fatal(e)
	}
	s := &Server{Store: st, Web: testWeb(), RequireSource: require}
	return s.Handler()
}

// mcpAs calls an MCP tool as an agent connection that sends the given headers, and returns
// the whole JSON-RPC result (isError included).
func mcpAs(t *testing.T, h http.Handler, headers map[string]string, tool string, args map[string]any) map[string]any {
	t.Helper()
	b, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": map[string]any{"name": tool, "arguments": args}})
	r := httptest.NewRequest("POST", "http://127.0.0.1:8080/mcp", bytes.NewReader(b))
	r.RemoteAddr = "192.168.1.9:1234"
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Accept", "application/json, text/event-stream")
	for k, v := range headers {
		r.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 200 {
		t.Fatalf("MCP %d: %s", w.Code, w.Body.String())
	}
	var out map[string]any
	if e := json.Unmarshal(w.Body.Bytes(), &out); e != nil || out["result"] == nil {
		t.Fatal(e, w.Body.String())
	}
	return out["result"].(map[string]any)
}

func agentPage(t *testing.T, h http.Handler, headers map[string]string, title string) string {
	t.Helper()
	res := mcpAs(t, h, headers, "create_artifact", map[string]any{"title": title, "kind": "markdown", "content": "# " + title})
	if res["isError"] == true {
		t.Fatal(res)
	}
	return res["structuredContent"].(map[string]any)["id"].(string)
}

// listed is GET /api/artifacts with a query, keyed by id to the item's source (nil for null).
func listed(t *testing.T, h http.Handler, query string) map[string]map[string]any {
	t.Helper()
	w := request(h, "GET", "/api/artifacts"+query, "")
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var items []map[string]any
	if e := json.Unmarshal(w.Body.Bytes(), &items); e != nil {
		t.Fatal(e)
	}
	out := map[string]map[string]any{}
	for _, it := range items {
		src, present := it["source"]
		if !present {
			t.Fatalf("item has no source key: %v", it)
		}
		m, _ := src.(map[string]any)
		out[it["id"].(string)] = m
	}
	return out
}

var hdr = map[string]string{"X-Origin": "personal", "X-Thread": "t-1"}

func TestPageSource(t *testing.T) {
	h := sourceServer(t, false)
	with := agentPage(t, h, hdr, "With")
	without := agentPage(t, h, nil, "Without")
	got := listed(t, h, "")
	if got[with]["origin"] != "personal" || got[with]["thread"] != "t-1" {
		t.Fatalf("source = %v", got[with])
	}
	if got[without] != nil {
		t.Fatalf("a page made without headers has source %v", got[without])
	}
	// The full read carries it too.
	a := request(h, "GET", "/api/artifacts/"+with, "").Body.String()
	if !strings.Contains(a, `"source":{"origin":"personal","thread":"t-1"}`) {
		t.Fatal(a)
	}
}

func TestPageSourceImmutable(t *testing.T) {
	h := sourceServer(t, false)
	other := map[string]string{"X-Origin": "work", "X-Thread": "t-2"}
	id := agentPage(t, h, hdr, "Page")
	bare := agentPage(t, h, nil, "Bare")
	check := func(step string) {
		t.Helper()
		got := listed(t, h, "?archived=include")
		if got[id]["origin"] != "personal" || got[id]["thread"] != "t-1" {
			t.Fatalf("%s: source of the sourced page = %v", step, got[id])
		}
		if got[bare] != nil {
			t.Fatalf("%s: a page with no source gained %v", step, got[bare])
		}
	}
	// Changes through /mcp, with different headers.
	for _, tc := range []struct {
		step string
		args map[string]any
	}{
		{"new version", map[string]any{"content": "# Two", "base_version": 1}},
		{"tag edit", map[string]any{"tags": []string{"x"}}},
		{"title edit", map[string]any{"title": "Renamed"}},
		{"archive", map[string]any{"archived": true}},
		{"restore", map[string]any{"archived": false}},
	} {
		for _, target := range []string{id, bare} {
			args := map[string]any{"id": target}
			for k, v := range tc.args {
				args[k] = v
			}
			if tc.step == "new version" || tc.step == "tag edit" || tc.step == "title edit" {
				args["base_version"] = latestVersion(t, h, target)
			}
			if res := mcpAs(t, h, other, "update_artifact", args); res["isError"] == true {
				t.Fatal(tc.step, res)
			}
		}
		check(tc.step)
	}
	// The plain web API never takes a source from a body: the field is refused, on create
	// and on update, and nothing changes.
	before := len(listed(t, h, "?archived=include"))
	if w := request(h, "POST", "/api/artifacts", `{"title":"T","kind":"markdown","content":"x","source":{"origin":"evil","thread":"z"}}`); w.Code != 400 {
		t.Fatal(w.Code, w.Body.String())
	}
	if len(listed(t, h, "?archived=include")) != before {
		t.Fatal("a refused create stored a page")
	}
	for _, target := range []string{id, bare} {
		v := latestVersion(t, h, target)
		if w := request(h, "PUT", "/api/artifacts/"+target, fmt.Sprintf(`{"content":"y","base_version":%d,"source":{"origin":"evil","thread":"z"}}`, v)); w.Code != 400 {
			t.Fatal(w.Code, w.Body.String())
		}
		if w := request(h, "PUT", "/api/artifacts/"+target, fmt.Sprintf(`{"content":"y","base_version":%d}`, v)); w.Code != 200 {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	check("PUT with a source in the body")
}

func latestVersion(t *testing.T, h http.Handler, id string) int {
	t.Helper()
	var a store.Artifact
	if e := json.Unmarshal(request(h, "GET", "/api/artifacts/"+id, "").Body.Bytes(), &a); e != nil {
		t.Fatal(e)
	}
	return len(a.Revisions)
}

// The store alone keeps a source from changing, whatever an update carries.
func TestStoreSourceSetOnceOnCreate(t *testing.T) {
	st, e := store.Open(t.TempDir())
	if e != nil {
		t.Fatal(e)
	}
	a, e := st.Save("", store.Input{Title: "T", Kind: "markdown", Content: "x", Source: &store.Source{Origin: "a", Thread: "1"}})
	if e != nil {
		t.Fatal(e)
	}
	b, e := st.Save(a.ID, store.Input{Content: "y", BaseVersion: 1, Source: &store.Source{Origin: "b", Thread: "2"}})
	if e != nil || b.Source == nil || b.Source.Origin != "a" {
		t.Fatal(e, b.Source)
	}
	n, _ := st.Save("", store.Input{Title: "N", Kind: "markdown", Content: "x"})
	n, e = st.Save(n.ID, store.Input{Content: "y", BaseVersion: 1, Source: &store.Source{Origin: "b", Thread: "2"}})
	if e != nil || n.Source != nil {
		t.Fatal(e, n.Source)
	}
}

func TestRequireSource(t *testing.T) {
	var logs bytes.Buffer
	log.SetOutput(&logs)
	defer log.SetOutput(log.Writer())
	h := sourceServer(t, true)
	for _, tc := range []struct {
		name    string
		headers map[string]string
		missing string
	}{
		{"none", nil, "X-Origin"},
		{"no thread", map[string]string{"X-Origin": "personal"}, "X-Thread"},
		{"no origin", map[string]string{"X-Thread": "t"}, "X-Origin"},
		{"empty thread", map[string]string{"X-Origin": "personal", "X-Thread": "  "}, "X-Thread"},
		{"empty origin", map[string]string{"X-Origin": "", "X-Thread": "t"}, "X-Origin"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			logs.Reset()
			res := mcpAs(t, h, tc.headers, "create_artifact", map[string]any{"title": "T", "kind": "markdown", "content": "x"})
			text := fmt.Sprint(res["content"])
			if res["isError"] != true || !strings.Contains(text, tc.missing) {
				t.Fatalf("not refused naming %s: %v", tc.missing, res)
			}
			if !strings.Contains(logs.String(), "refused") || !strings.Contains(logs.String(), tc.missing) {
				t.Fatalf("refusal not logged: %q", logs.String())
			}
		})
	}
	if n := len(listed(t, h, "")); n != 0 {
		t.Fatalf("%d pages stored after refusals", n)
	}
	// Both headers present: created with its source.
	id := agentPage(t, h, hdr, "Ok")
	if got := listed(t, h, ""); got[id]["origin"] != "personal" {
		t.Fatal(got)
	}
	// Setting off: the same create without headers succeeds.
	off := sourceServer(t, false)
	if id := agentPage(t, off, nil, "Open"); listed(t, off, "")[id] != nil {
		t.Fatal("expected null source")
	}
}

func TestRequireSourceLibraryUnaffected(t *testing.T) {
	h := sourceServer(t, true)
	w := request(h, "POST", "/api/artifacts", `{"title":"Mine","kind":"markdown","content":"x"}`)
	if w.Code != 201 {
		t.Fatal(w.Code, w.Body.String())
	}
	m := upload(t, h, "text/csv", "data.csv", []byte("a,b\n1,2\n"))
	f := saveFile(t, h, "Data", m.URL)
	got := listed(t, h, "")
	if len(got) != 2 || got[f.ID] != nil {
		t.Fatalf("library pages = %v", got)
	}
	for id, src := range got {
		if src != nil {
			t.Fatalf("%s has source %v", id, src)
		}
	}
}

func TestListByOrigin(t *testing.T) {
	h := sourceServer(t, false)
	p := agentPage(t, h, map[string]string{"X-Origin": "personal", "X-Thread": "a"}, "P")
	w := agentPage(t, h, map[string]string{"X-Origin": "work", "X-Thread": "b"}, "W")
	n := agentPage(t, h, nil, "N")
	keys := func(m map[string]map[string]any) string {
		var ids []string
		for id := range m {
			ids = append(ids, id)
		}
		return fmt.Sprint(len(ids), m[p] != nil, m[w] != nil)
	}
	if got := listed(t, h, "?origin=personal"); len(got) != 1 || got[p]["origin"] != "personal" {
		t.Fatal(keys(got))
	}
	if got := listed(t, h, "?no_source=1"); len(got) != 1 || func() bool { _, ok := got[n]; return !ok }() {
		t.Fatal(keys(got))
	}
	if got := listed(t, h, ""); len(got) != 3 {
		t.Fatal("unfiltered list changed", keys(got))
	}
	// The MCP list and search tools carry source.
	list := mcpAs(t, h, nil, "list_artifacts", map[string]any{})["structuredContent"].(map[string]any)["artifacts"].([]any)
	search := mcpAs(t, h, nil, "search_artifacts", map[string]any{"query": "P"})["structuredContent"].(map[string]any)["results"].([]any)
	seen := 0
	for _, set := range [][]any{list, search} {
		for _, it := range set {
			m := it.(map[string]any)
			if _, ok := m["source"]; !ok {
				t.Fatalf("no source key: %v", m)
			}
			if m["id"] == p {
				if s, _ := m["source"].(map[string]any); s["origin"] != "personal" || s["thread"] != "a" {
					t.Fatal(m)
				}
				seen++
			}
		}
	}
	if seen != 2 {
		t.Fatalf("page seen with its source %d times, want 2 (list and search)", seen)
	}
}
