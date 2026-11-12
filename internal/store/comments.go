package store

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// A Comment is feedback on an artifact. A thread is a root comment (Parent empty) and its
// replies; only roots are resolved. Comments live beside the artifact, outside its
// revisions, and are deleted with it.
type Comment struct {
	ID     string `json:"id"`
	Parent string `json:"parent,omitempty"`
	Author string `json:"author"`
	Body   string `json:"body"`
	Quote  string `json:"quote,omitempty"`
	// Anchor is where a page placed the comment (a CSS path), Element the opening tag of
	// what it points at (so an agent can find it in the source), and ToClaude marks one
	// the person sent to their agent ("Send to Claude").
	Anchor    string    `json:"anchor,omitempty"`
	Element   string    `json:"element,omitempty"`
	ToClaude  bool      `json:"to_claude,omitempty"`
	Version   int       `json:"version"`
	Resolved  bool      `json:"resolved,omitempty"`
	CreatedAt time.Time `json:"created_at"`
	// Stroke is a drawing the comment started (roots only).
	Stroke *Stroke `json:"stroke,omitempty"`
	// Match is the last report of whether a page still shows what the comment points at.
	// Status is derived from it when comments are read and is never stored; roots only.
	Match  *Match `json:"match,omitempty"`
	Status string `json:"status,omitempty"`
}

// A Match is a page's report, for one artifact version, of whether what a comment points at
// was found in it. The server has no DOM, so whatever renders the page makes the report.
type Match struct {
	Version int       `json:"version"`
	Found   bool      `json:"found"`
	At      time.Time `json:"at"`
}

// MatchResult is one comment's outcome in a report.
type MatchResult struct {
	ID    string `json:"id"`
	Found bool   `json:"found"`
}

// Comment statuses: current (made on the latest version), ok and lost (a report for the
// latest version found it or did not), unchecked (made on an older version and nobody has
// checked the latest).
const (
	StatusCurrent   = "current"
	StatusOK        = "ok"
	StatusLost      = "lost"
	StatusUnchecked = "unchecked"
)

func commentStatus(c Comment, latest int) string {
	switch {
	case c.Version == latest:
		return StatusCurrent
	case c.Match != nil && c.Match.Version == latest && c.Match.Found:
		return StatusOK
	case c.Match != nil && c.Match.Version == latest:
		return StatusLost
	}
	return StatusUnchecked
}

type CommentInput struct {
	Parent   string `json:"parent,omitempty"`
	Author   string `json:"author,omitempty"`
	Body     string `json:"body"`
	Quote    string `json:"quote,omitempty"`
	Anchor   string `json:"anchor,omitempty"`
	Element  string `json:"element,omitempty"`
	ToClaude bool   `json:"to_claude,omitempty"`
	// Version is the one the person was looking at; zero means the latest.
	Version int `json:"version,omitempty"`
	// Stroke is a drawing, allowed on a thread's first comment only.
	Stroke *Stroke `json:"stroke,omitempty"`
}

const maxComments = 1000

func (s *Store) commentsPath(id string) string {
	return filepath.Join(s.dir, "comments", id+".json")
}

func (s *Store) loadComments() error {
	files, err := filepath.Glob(filepath.Join(s.dir, "comments", "*.json"))
	if err != nil {
		return err
	}
	s.comments = map[string][]Comment{}
	for _, f := range files {
		id := strings.TrimSuffix(filepath.Base(f), ".json")
		if _, ok := s.items[id]; !ok {
			continue // left behind by an interrupted delete
		}
		b, err := os.ReadFile(f)
		if err != nil {
			return err
		}
		var list []Comment
		if err = json.Unmarshal(b, &list); err != nil {
			return fmt.Errorf("read %s: %w", f, err)
		}
		s.comments[id] = list
	}
	return nil
}

// Comments returns an artifact's comments, oldest first.
func (s *Store) Comments(id string) ([]Comment, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.items[id]; !ok {
		return nil, ErrNotFound
	}
	list := append([]Comment{}, s.comments[id]...)
	latest := len(s.items[id].Revisions)
	for i, c := range list {
		if c.Parent == "" {
			list[i].Status = commentStatus(c, latest)
		}
	}
	return list, nil
}

func (s *Store) AddComment(id string, in CommentInput) (Comment, error) {
	in.Body = strings.TrimSpace(in.Body)
	if in.Body == "" || len(in.Body) > 10000 {
		return Comment{}, errors.New("comment must contain 1–10000 bytes")
	}
	if len(in.Quote) > 2000 || len(in.Anchor) > 2000 || len(in.Element) > 2000 {
		return Comment{}, errors.New("quote, anchor and element are at most 2000 bytes each")
	}
	var stroke *Stroke
	if in.Stroke != nil {
		if in.Parent != "" {
			return Comment{}, errors.New("a reply cannot carry a stroke; draw on a thread's first comment")
		}
		var err error
		if stroke, err = checkStroke(in.Stroke); err != nil {
			return Comment{}, err
		}
	}
	author := strings.TrimSpace(in.Author)
	if author == "" {
		author = "you"
	}
	if len(author) > 60 {
		return Comment{}, errors.New("author exceeds 60 bytes")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	a, ok := s.items[id]
	if !ok {
		return Comment{}, ErrNotFound
	}
	version := len(a.Revisions)
	if in.Version != 0 {
		if in.Version < 1 || in.Version > version {
			return Comment{}, fmt.Errorf("version must be between 1 and %d", version)
		}
		version = in.Version
	}
	list := s.comments[id]
	if len(list) >= maxComments {
		return Comment{}, fmt.Errorf("an artifact holds at most %d comments", maxComments)
	}
	if in.Parent != "" {
		root := -1
		for i, c := range list {
			if c.ID == in.Parent {
				root = i
			}
		}
		if root < 0 || list[root].Parent != "" {
			return Comment{}, errors.New("parent must be the ID of a thread's first comment")
		}
	}
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		return Comment{}, err
	}
	c := Comment{ID: hex.EncodeToString(b), Parent: in.Parent, Author: author, Body: in.Body, Quote: in.Quote, Anchor: in.Anchor, Element: in.Element, ToClaude: in.ToClaude, Version: version, CreatedAt: time.Now().UTC()}
	if stroke != nil {
		stroke.Version = version
		c.Stroke = stroke
		if c.Anchor == "" {
			c.Anchor = stroke.Anchor // so pins and agents that read only anchor still find the element
		}
	}
	if err := s.writeComments(id, append(append([]Comment{}, list...), c)); err != nil {
		return Comment{}, err
	}
	go s.changed(id, "comments", c.ID)
	if c.Parent == "" {
		c.Status = commentStatus(c, len(a.Revisions))
	}
	return c, nil
}

// ResolveComment marks a thread resolved or reopens it.
func (s *Store) ResolveComment(id, commentID string, resolved bool) (Comment, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	a, ok := s.items[id]
	if !ok {
		return Comment{}, ErrNotFound
	}
	list := append([]Comment{}, s.comments[id]...)
	for i, c := range list {
		if c.ID == commentID {
			if c.Parent != "" {
				return Comment{}, errors.New("resolve the thread's first comment")
			}
			list[i].Resolved = resolved
			if err := s.writeComments(id, list); err != nil {
				return Comment{}, err
			}
			go s.changed(id, "comments", commentID)
			out := list[i]
			out.Status = commentStatus(out, len(a.Revisions))
			return out, nil
		}
	}
	return Comment{}, errors.New("comment not found")
}

// RecordMatches stores a page's report, for an artifact version, of whether each named
// thread's target was found in it. Ids that are not threads of this artifact are ignored, and
// so is a report older than the one a thread already holds. It returns how many changed.
func (s *Store) RecordMatches(id string, version int, results []MatchResult) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	a, ok := s.items[id]
	if !ok {
		return 0, ErrNotFound
	}
	if version < 1 || version > len(a.Revisions) {
		return 0, fmt.Errorf("version must be between 1 and %d", len(a.Revisions))
	}
	list := append([]Comment{}, s.comments[id]...)
	now, changed := time.Now().UTC(), 0
	for _, r := range results {
		for i, c := range list {
			if c.ID != r.ID || c.Parent != "" || c.Match != nil && (c.Match.Version > version || c.Match.Version == version && c.Match.Found == r.Found) {
				continue
			}
			list[i].Match = &Match{Version: version, Found: r.Found, At: now}
			changed++
		}
	}
	if changed == 0 {
		return 0, nil
	}
	if err := s.writeComments(id, list); err != nil {
		return 0, err
	}
	// No change event: viewers that disagree would wake each other into re-reporting.
	return changed, nil
}

// DeleteThread removes a thread and its replies; false when there is no such thread.
func (s *Store) DeleteThread(id, threadID string) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.items[id]; !ok {
		return false, ErrNotFound
	}
	keep, found := []Comment{}, false
	for _, c := range s.comments[id] {
		if c.ID == threadID && c.Parent == "" {
			found = true
		} else if c.Parent != threadID {
			keep = append(keep, c)
		}
	}
	if !found {
		return false, nil
	}
	if err := s.writeComments(id, keep); err != nil {
		return false, err
	}
	go s.changed(id, "comments", threadID)
	return true, nil
}

// writeComments persists an artifact's comments. s.mu is held.
func (s *Store) writeComments(id string, list []Comment) error {
	dir := filepath.Join(s.dir, "comments")
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	b, err := json.MarshalIndent(list, "", "  ")
	if err != nil {
		return err
	}
	if err = writeAtomic(dir, s.commentsPath(id), b); err != nil {
		return err
	}
	if s.comments == nil {
		s.comments = map[string][]Comment{}
	}
	s.comments[id] = list
	return nil
}

// openThreads counts unresolved threads. s.mu is held.
func (s *Store) openThreads(id string) int {
	n := 0
	for _, c := range s.comments[id] {
		if c.Parent == "" && !c.Resolved {
			n++
		}
	}
	return n
}
