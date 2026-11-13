package server

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/LaneBirmingham/shartifacts/internal/store"
)

func commentsTool(t *testing.T, h http.Handler, args map[string]any) map[string]any {
	t.Helper()
	b, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": map[string]any{"name": "artifact_comments", "arguments": args}})
	return mcpRequest(t, h, "http://127.0.0.1:8080", string(b))
}

func newPage(t *testing.T, h http.Handler) string {
	t.Helper()
	var a store.Artifact
	json.Unmarshal(request(h, "POST", "/api/artifacts", `{"title":"Page","kind":"html","content":"x"}`).Body.Bytes(), &a)
	return a.ID
}

const strokeBody = `{"body":"this bar","anchor":"#chart > svg","stroke":{"v":1,"version":7,"viewport":{"w":390,"h":844,"scroll_x":0,"scroll_y":312},"anchor":"#chart > svg","box":{"x":24,"y":400,"w":342,"h":210},"points":[[3.2,10.5,0.5],[4,11.9,0.6]],"color":"#d33","width":4,"elements":[{"path":"#chart > svg > rect:nth-of-type(2)","tag":"<rect class=\"bar\">","text":"Q2 revenue"}]}}`

func TestStrokeOverHTTPAndMCP(t *testing.T) {
	h := testServer(t)
	id := newPage(t, h)
	w := request(h, "POST", "/api/artifacts/"+id+"/comments", strokeBody)
	var root store.Comment
	json.Unmarshal(w.Body.Bytes(), &root)
	if w.Code != 201 || root.Stroke == nil || root.Stroke.Version != 1 {
		t.Fatal("the server sets stroke.version from the comment, not the client", w.Code, w.Body.String())
	}
	w = request(h, "GET", "/api/artifacts/"+id+"/comments", "")
	var list []store.Comment
	json.Unmarshal(w.Body.Bytes(), &list)
	if len(list) != 1 || list[0].Stroke == nil || len(list[0].Stroke.Points) != 2 || list[0].Stroke.Elements[0].Text != "Q2 revenue" || list[0].Stroke.Viewport.ScrollY != 312 {
		t.Fatal(w.Body.String())
	}
	// An agent draws through artifact_comments add; the thread comes back from list.
	added := commentsTool(t, h, map[string]any{"id": id, "op": "add", "body": "agent mark", "stroke": map[string]any{"points": [][]float64{{1, 2}, {3, 4, 0.9}}, "anchor": "main", "anchor_tag": "main", "anchor_text": ""}})
	if added["isError"] == true {
		t.Fatal(added)
	}
	mine := added["structuredContent"].(map[string]any)
	// An empty anchor_text is a statement (no text), and it comes back as one.
	if txt, has := mine["stroke"].(map[string]any)["anchor_text"]; !has || txt != "" || mine["stroke"].(map[string]any)["anchor_tag"] != "main" {
		t.Fatal("anchor_tag and an empty anchor_text did not round-trip over MCP", mine)
	}
	if mine["stroke"].(map[string]any)["version"] != float64(1) || mine["anchor"] != "main" {
		t.Fatal(mine)
	}
	listed := commentsTool(t, h, map[string]any{"id": id, "op": "list"})["structuredContent"].(map[string]any)["threads"].([]any)
	if len(listed) != 2 || listed[0].(map[string]any)["stroke"].(map[string]any)["color"] != "#d33" || listed[1].(map[string]any)["stroke"] == nil {
		t.Fatal(listed)
	}
	// A reply cannot carry a stroke, over either door.
	if w = request(h, "POST", "/api/artifacts/"+id+"/comments", `{"body":"r","parent":"`+root.ID+`","stroke":{"points":[[1,1]]}}`); w.Code != 400 {
		t.Fatal(w.Code, w.Body.String())
	}
	if r := commentsTool(t, h, map[string]any{"id": id, "op": "add", "parent": root.ID, "body": "r", "stroke": map[string]any{"points": [][]float64{{1, 1}}}}); r["isError"] != true {
		t.Fatal("reply with a stroke accepted over MCP", r)
	}
	// Too large is a 400 with the contract's message.
	pts := strings.Repeat("[1,1],", 3000) + "[1,1]"
	if w = request(h, "POST", "/api/artifacts/"+id+"/comments", `{"body":"big","stroke":{"points":[`+pts+`]}}`); w.Code != 400 || !strings.Contains(w.Body.String(), "stroke too large") {
		t.Fatal(w.Code, w.Body.String())
	}
}

func TestCommentStatusOverHTTPAndMCP(t *testing.T) {
	h := testServer(t)
	id := newPage(t, h)
	var root store.Comment
	json.Unmarshal(request(h, "POST", "/api/artifacts/"+id+"/comments", `{"body":"reworded?","quote":"Totals"}`).Body.Bytes(), &root)
	get := func() store.Comment {
		var list []store.Comment
		json.Unmarshal(request(h, "GET", "/api/artifacts/"+id+"/comments", "").Body.Bytes(), &list)
		return list[0]
	}
	mcpStatus := func() string {
		th := commentsTool(t, h, map[string]any{"id": id, "op": "list"})["structuredContent"].(map[string]any)["threads"].([]any)
		return th[0].(map[string]any)["status"].(string)
	}
	if c := get(); c.Status != "current" || c.Match != nil || mcpStatus() != "current" {
		t.Fatal(c)
	}
	if w := request(h, "PUT", "/api/artifacts/"+id, `{"title":"Page","kind":"html","content":"y","base_version":1}`); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if c := get(); c.Status != "unchecked" || mcpStatus() != "unchecked" {
		t.Fatal(c)
	}
	match := func(body string) (int, string) {
		w := request(h, "POST", "/api/artifacts/"+id+"/comments/matches", body)
		return w.Code, w.Body.String()
	}
	if code, body := match(`{"version":2,"results":[{"id":"` + root.ID + `","found":false},{"id":"nope","found":true}]}`); code != 200 || body != `{"updated":1}`+"\n" {
		t.Fatal(code, body)
	}
	if c := get(); c.Status != "lost" || c.Match == nil || c.Match.Version != 2 || c.Match.Found || mcpStatus() != "lost" {
		t.Fatal(c)
	}
	if code, _ := match(`{"version":3,"results":[]}`); code != 400 {
		t.Fatal("a report for a version that does not exist was accepted")
	}
	if code, _ := match(`{"version":2,"results":[{"id":"` + root.ID + `","found":true}]}`); code != 200 || get().Status != "ok" {
		t.Fatal("the same version can be re-reported", get())
	}
}
