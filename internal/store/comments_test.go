package store

import (
	"errors"
	"os"
	"strings"
	"testing"
)

func TestComments(t *testing.T) {
	dir := t.TempDir()
	s, _ := Open(dir)
	a, _ := s.Save("", Input{Title: "Page", Kind: "html", Content: "x"})
	if _, e := s.AddComment("nope", CommentInput{Body: "hi"}); !errors.Is(e, ErrNotFound) {
		t.Fatal(e)
	}
	if _, e := s.AddComment(a.ID, CommentInput{Body: "  "}); e == nil {
		t.Fatal("empty comment accepted")
	}
	root, e := s.AddComment(a.ID, CommentInput{Body: "Make the button bigger", Quote: "<button>"})
	if e != nil || root.Author != "you" || root.Version != 1 {
		t.Fatal(e, root)
	}
	reply, e := s.AddComment(a.ID, CommentInput{Parent: root.ID, Author: "agent", Body: "Done in v2"})
	if e != nil {
		t.Fatal(e)
	}
	if _, e = s.AddComment(a.ID, CommentInput{Parent: reply.ID, Body: "nested"}); e == nil {
		t.Fatal("reply to a reply accepted")
	}
	if _, e = s.ResolveComment(a.ID, reply.ID, true); e == nil {
		t.Fatal("resolved a reply")
	}
	if s.List(ExcludeArchived)[0].OpenComments != 1 {
		t.Fatal("open thread not counted")
	}
	if _, e = s.ResolveComment(a.ID, root.ID, true); e != nil {
		t.Fatal(e)
	}
	reopened, e := Open(dir)
	if e != nil {
		t.Fatal(e)
	}
	list, _ := reopened.Comments(a.ID)
	if len(list) != 2 || !list[0].Resolved || list[1].Parent != root.ID || reopened.List(ExcludeArchived)[0].OpenComments != 0 {
		t.Fatal(list)
	}
	// A comment made on the preview keeps what it pointed at and the version it was made on.
	b, e := reopened.Save(a.ID, Input{Title: "Page", Kind: "html", Content: "y", BaseVersion: 1})
	if e != nil {
		t.Fatal(e)
	}
	pointed, e := reopened.AddComment(b.ID, CommentInput{Body: "Bolder", Quote: "Totals", Anchor: "main > h2", Element: `<h2 class="title">`, Version: 1})
	if e != nil || pointed.Element != `<h2 class="title">` || pointed.Anchor != "main > h2" || pointed.Version != 1 {
		t.Fatal(e, pointed)
	}
	if latest, _ := reopened.AddComment(b.ID, CommentInput{Body: "Latest"}); latest.Version != 2 {
		t.Fatal("version did not default to the latest", latest)
	}
	for _, bad := range []CommentInput{{Body: "x", Version: 3}, {Body: "x", Version: -1}, {Body: "x", Element: "<" + strings.Repeat("a", 2000) + ">"}} {
		if _, e = reopened.AddComment(b.ID, bad); e == nil {
			t.Fatal("accepted", bad)
		}
	}
	if e = reopened.Delete(a.ID, 2); e != nil {
		t.Fatal(e)
	}
	if again, _ := Open(dir); len(again.comments) != 0 {
		t.Fatal("comments outlived their artifact")
	}
}

func strokeInput(points int) *Stroke {
	st := &Stroke{Version: 99, Anchor: "#chart > svg", Box: StrokeBox{X: 24, Y: 400, W: 342, H: 210}, Color: "#d33", Width: 4,
		Viewport: StrokeViewport{W: 390, H: 844, ScrollY: 312}}
	for i := 0; i < points; i++ {
		st.Points = append(st.Points, []float64{float64(i), float64(i) / 2, 0.5})
	}
	return st
}

func TestStrokeRoundTrip(t *testing.T) {
	dir := t.TempDir()
	s, _ := Open(dir)
	a, _ := s.Save("", Input{Title: "Page", Kind: "html", Content: "x"})
	b, _ := s.Save(a.ID, Input{Title: "Page", Kind: "html", Content: "y", BaseVersion: 1})
	st := strokeInput(2)
	st.AnchorTag, st.AnchorText = "svg", "Revenue by quarter"
	st.Elements = []StrokeElement{{Path: "#chart > svg > rect", Tag: `<rect class="bar">`, Text: "Q2 revenue"}}
	root, e := s.AddComment(b.ID, CommentInput{Body: "this bar", Version: 1, Stroke: st})
	if e != nil || root.Stroke == nil || root.Stroke.Version != 1 || root.Stroke.V != 1 {
		t.Fatal("the store must set stroke.version from the comment and v to 1", e, root.Stroke)
	}
	if root.Anchor != "#chart > svg" || root.Quote != "" {
		t.Fatal("a drawing's anchor is copied to the comment and its quote stays empty", root)
	}
	if st.Version != 99 {
		t.Fatal("the caller's stroke was changed")
	}
	again, _ := Open(dir)
	list, _ := again.Comments(b.ID)
	if len(list) != 1 || list[0].Stroke == nil || list[0].Stroke.Version != 1 || len(list[0].Stroke.Points) != 2 || list[0].Stroke.Points[1][1] != 0.5 || list[0].Stroke.Elements[0].Text != "Q2 revenue" || list[0].Stroke.Box.H != 210 || list[0].Stroke.AnchorTag != "svg" || list[0].Stroke.AnchorText != "Revenue by quarter" {
		t.Fatal("stroke did not survive a reload", list)
	}
}

func TestStrokeRefused(t *testing.T) {
	s, _ := Open(t.TempDir())
	a, _ := s.Save("", Input{Title: "Page", Kind: "html", Content: "x"})
	root, _ := s.AddComment(a.ID, CommentInput{Body: "root"})
	if _, e := s.AddComment(a.ID, CommentInput{Body: "reply", Parent: root.ID, Stroke: strokeInput(1)}); e == nil || !strings.Contains(e.Error(), "reply") {
		t.Fatal("a reply with a stroke was accepted", e)
	}
	big := strokeInput(1)
	for i := 0; i < 20; i++ {
		big.Elements = append(big.Elements, StrokeElement{Path: strings.Repeat("a", 5000)})
	}
	tooMany := strokeInput(1)
	tooMany.Elements = make([]StrokeElement, 21)
	longText := strokeInput(1)
	longText.Elements = []StrokeElement{{Path: "a", Text: strings.Repeat("é", 121)}}
	longAnchorText := strokeInput(1)
	longAnchorText.AnchorText = strings.Repeat("é", 121)
	for name, bad := range map[string]*Stroke{"points": strokeInput(3001), "elements": tooMany, "bytes": big, "text": longText, "anchor text": longAnchorText} {
		if _, e := s.AddComment(a.ID, CommentInput{Body: "x", Stroke: bad}); e == nil || e.Error() != "stroke too large" {
			t.Fatal(name, e)
		}
	}
	if _, e := s.AddComment(a.ID, CommentInput{Body: "x", Stroke: strokeInput(3000)}); e != nil {
		t.Fatal("3000 points is within the limit", e)
	}
	longTag := strokeInput(1)
	longTag.AnchorTag = strings.Repeat("a", 41)
	if _, e := s.AddComment(a.ID, CommentInput{Body: "x", Stroke: longTag}); e == nil {
		t.Fatal("an anchor_tag over 40 bytes was accepted")
	}
	empty := strokeInput(0)
	badPressure := strokeInput(1)
	badPressure.Points[0][2] = 1.5
	for name, bad := range map[string]*Stroke{"no points": empty, "pressure": badPressure} {
		if _, e := s.AddComment(a.ID, CommentInput{Body: "x", Stroke: bad}); e == nil {
			t.Fatal(name, "accepted")
		}
	}
}

func TestCommentStatus(t *testing.T) {
	dir := t.TempDir()
	s, _ := Open(dir)
	a, _ := s.Save("", Input{Title: "Page", Kind: "html", Content: "x"})
	status := func(st *Store, id string) (string, *Match) {
		t.Helper()
		list, e := st.Comments(a.ID)
		if e != nil {
			t.Fatal(e)
		}
		for _, c := range list {
			if c.ID == id {
				return c.Status, c.Match
			}
		}
		t.Fatal("no comment", id)
		return "", nil
	}
	root, _ := s.AddComment(a.ID, CommentInput{Body: "the title", Quote: "Totals"})
	reply, _ := s.AddComment(a.ID, CommentInput{Body: "reply", Parent: root.ID})
	if root.Status != "current" {
		t.Fatal("a new comment is current", root.Status)
	}
	if st, m := status(s, root.ID); st != "current" || m != nil {
		t.Fatal(st, m)
	}
	if list, _ := s.Comments(a.ID); list[1].ID != reply.ID || list[1].Status != "" {
		t.Fatal("replies carry no status", list[1])
	}
	save := func(v int) {
		t.Helper()
		if _, e := s.Save(a.ID, Input{Title: "Page", Kind: "html", Content: "v", BaseVersion: v}); e != nil {
			t.Fatal(e)
		}
	}
	save(1)
	if st, _ := status(s, root.ID); st != "unchecked" {
		t.Fatal("older and unchecked", st)
	}
	report := func(version int, found bool, ids ...string) int {
		t.Helper()
		var rs []MatchResult
		for _, id := range ids {
			rs = append(rs, MatchResult{ID: id, Found: found})
		}
		n, e := s.RecordMatches(a.ID, version, rs)
		if e != nil {
			t.Fatal(e)
		}
		return n
	}
	if report(2, true, root.ID) != 1 {
		t.Fatal("report not stored")
	}
	if st, m := status(s, root.ID); st != "ok" || m == nil || m.Version != 2 || !m.Found || m.At.IsZero() {
		t.Fatal(st, m)
	}
	if report(2, false, root.ID) != 1 {
		t.Fatal("a newer answer for the same version replaces the old one")
	}
	if st, _ := status(s, root.ID); st != "lost" {
		t.Fatal(st)
	}
	if report(2, false, root.ID) != 0 {
		t.Fatal("an identical report is not a change")
	}
	// A new version puts the comment back to unchecked, whatever was reported before.
	save(2)
	if st, m := status(s, root.ID); st != "unchecked" || m == nil || m.Version != 2 {
		t.Fatal("a report for an older version is not a report for this one", st, m)
	}
	if report(3, true, root.ID) != 1 {
		t.Fatal()
	}
	if report(2, false, root.ID) != 0 {
		t.Fatal("a report older than the stored one was applied")
	}
	if st, m := status(s, root.ID); st != "ok" || m.Version != 3 {
		t.Fatal("older report changed the status", st, m)
	}
	if report(3, true, "nope", reply.ID) != 0 {
		t.Fatal("unknown ids and replies are ignored")
	}
	if _, e := s.RecordMatches(a.ID, 4, nil); e == nil {
		t.Fatal("a report for a version that does not exist was accepted")
	}
	if _, e := s.RecordMatches(a.ID, 0, nil); e == nil {
		t.Fatal("version 0 accepted")
	}
	if _, e := s.RecordMatches("nope", 1, nil); !errors.Is(e, ErrNotFound) {
		t.Fatal(e)
	}
	// The match is stored and survives a reload; the status is derived and never written.
	again, _ := Open(dir)
	if st, m := status(again, root.ID); st != "ok" || m.Version != 3 {
		t.Fatal(st, m)
	}
	b, _ := os.ReadFile(again.commentsPath(a.ID))
	if strings.Contains(string(b), `"status"`) || !strings.Contains(string(b), `"match"`) {
		t.Fatal("status was stored, or match was not", string(b))
	}
	// New version, new comment: made on the latest, so current again.
	if _, e := again.Save(a.ID, Input{Title: "Page", Kind: "html", Content: "w", BaseVersion: 3}); e != nil {
		t.Fatal(e)
	}
	fresh, _ := again.AddComment(a.ID, CommentInput{Body: "now"})
	if st, _ := status(again, fresh.ID); st != "current" {
		t.Fatal(st)
	}
	if st, _ := status(again, root.ID); st != "unchecked" {
		t.Fatal(st)
	}
}
