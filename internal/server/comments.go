package server

import (
	"context"
	"errors"
	"net/http"

	"github.com/LaneBirmingham/shartifacts/internal/store"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func (s *Server) commentRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/artifacts/{id}/comments", func(w http.ResponseWriter, r *http.Request) {
		list, e := s.Store.Comments(r.PathValue("id"))
		respond(w, 200, list, e)
	})
	mux.HandleFunc("POST /api/artifacts/{id}/comments", func(w http.ResponseWriter, r *http.Request) {
		var in store.CommentInput
		if !decode(w, r, &in) {
			return
		}
		c, e := s.Store.AddComment(r.PathValue("id"), in)
		respond(w, 201, c, e)
	})
	// Whatever renders the page (a person's browser, an agent's check) reports whether each
	// thread's target is still in the latest version; the server has no DOM to look in.
	mux.HandleFunc("POST /api/artifacts/{id}/comments/matches", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Version int                 `json:"version"`
			Results []store.MatchResult `json:"results"`
		}
		if !decode(w, r, &in) {
			return
		}
		n, e := s.Store.RecordMatches(r.PathValue("id"), in.Version, in.Results)
		respond(w, 200, map[string]int{"updated": n}, e)
	})
	mux.HandleFunc("DELETE /api/artifacts/{id}/comments/{comment}", func(w http.ResponseWriter, r *http.Request) {
		deleted, e := s.Store.DeleteThread(r.PathValue("id"), r.PathValue("comment"))
		respond(w, 200, map[string]bool{"deleted": deleted}, e)
	})
	mux.HandleFunc("PUT /api/artifacts/{id}/comments/{comment}", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Resolved bool `json:"resolved"`
		}
		if !decode(w, r, &in) {
			return
		}
		c, e := s.Store.ResolveComment(r.PathValue("id"), r.PathValue("comment"), in.Resolved)
		respond(w, 200, c, e)
	})
}

type thread struct {
	store.Comment
	Replies []store.Comment `json:"replies,omitempty"`
}

// threads groups replies under their first comment, keeping open threads unless all is set.
func threads(list []store.Comment, all bool) []thread {
	out := []thread{}
	index := map[string]int{}
	for _, c := range list {
		if c.Parent == "" {
			if c.Resolved && !all {
				continue
			}
			index[c.ID] = len(out)
			out = append(out, thread{Comment: c})
		} else if i, ok := index[c.Parent]; ok {
			out[i].Replies = append(out[i].Replies, c)
		}
	}
	return out
}

func (s *Server) addCommentTool(m *mcp.Server) {
	type CommentsInput struct {
		ID        string        `json:"id"`
		Op        string        `json:"op" jsonschema:"list (open threads), add, resolve or reopen"`
		Body      string        `json:"body,omitempty"`
		Parent    string        `json:"parent,omitempty" jsonschema:"Thread ID to reply to with add"`
		CommentID string        `json:"comment_id,omitempty" jsonschema:"Thread ID for resolve or reopen"`
		All       bool          `json:"all,omitempty" jsonschema:"list resolved threads too"`
		Stroke    *store.Stroke `json:"stroke,omitempty" jsonschema:"add: a drawing on the page, for a new thread (not a reply)"`
	}
	mcp.AddTool(m, &mcp.Tool{Name: "artifact_comments", Description: "Read and answer the user's comment threads on an artifact. A thread made by pointing at the page carries what it points at: quote (its text), element (its opening tag, to find in the source) and anchor (a CSS path). A thread the person drew has a stroke: the drawing as points relative to its anchor element's box, the elements under it, and the version drawn on. Each thread has a status: current (made on the latest version), ok or lost (a page check found its target in the latest version or did not), unchecked (older, and not checked against the latest); match is the last check. Reply (add with parent) and resolve once addressed."}, func(ctx context.Context, req *mcp.CallToolRequest, in CommentsInput) (*mcp.CallToolResult, any, error) {
		switch in.Op {
		case "list":
			list, e := s.Store.Comments(in.ID)
			if e != nil {
				return nil, nil, e
			}
			return nil, map[string]any{"threads": threads(list, in.All)}, nil
		case "add":
			c, e := s.Store.AddComment(in.ID, store.CommentInput{Parent: in.Parent, Author: "agent", Body: in.Body, Stroke: in.Stroke})
			return nil, c, e
		case "resolve", "reopen":
			c, e := s.Store.ResolveComment(in.ID, in.CommentID, in.Op == "resolve")
			return nil, c, e
		}
		return nil, nil, errors.New("op must be list, add, resolve or reopen")
	})
}
