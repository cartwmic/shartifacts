package server

import (
	"fmt"
	"log"
	"net/http"
	"strings"

	"github.com/LaneBirmingham/shartifacts/internal/store"
)

// sourceHeaders are the X-Origin and X-Thread values an agent connection sent, trimmed.
// Only the /mcp adapter reads them; the store gets plain values.
type sourceHeaders struct{ Origin, Thread string }

func sourceOf(r *http.Request) sourceHeaders {
	return sourceHeaders{strings.TrimSpace(r.Header.Get("X-Origin")), strings.TrimSpace(r.Header.Get("X-Thread"))}
}

// sourceForCreate is the source to store for a page an agent creates. With neither header
// it is nil (the page has no source); with RequireSource, a missing header refuses the
// create, and the refusal is logged.
func (s *Server) sourceForCreate(h sourceHeaders) (*store.Source, error) {
	if s.RequireSource {
		var missing []string
		if h.Origin == "" {
			missing = append(missing, "X-Origin")
		}
		if h.Thread == "" {
			missing = append(missing, "X-Thread")
		}
		if len(missing) > 0 {
			log.Printf("create_artifact refused: missing header %s (SHARTIFACTS_REQUIRE_SOURCE is on)", strings.Join(missing, ", "))
			return nil, fmt.Errorf("missing header %s: set X-Origin and X-Thread in this agent connection's headers", strings.Join(missing, " and "))
		}
	}
	if h.Origin == "" && h.Thread == "" {
		return nil, nil
	}
	return &store.Source{Origin: h.Origin, Thread: h.Thread}, nil
}
