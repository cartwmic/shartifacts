package store

import (
	"encoding/json"
	"errors"
	"unicode/utf8"
)

// A Stroke is a freehand drawing a person made on an artifact's page, kept with the comment
// it started. Points are relative to the box of the element the drawing is anchored to, so a
// later version of the page can place the drawing on that element wherever it has moved.
type Stroke struct {
	V int `json:"v,omitempty"`
	// Version is the artifact version drawn on. The store sets it from the comment's own
	// version, so a client cannot disagree with the comment it belongs to.
	Version  int            `json:"version,omitempty"`
	Viewport StrokeViewport `json:"viewport,omitempty"`
	Anchor   string         `json:"anchor,omitempty"`
	Box      StrokeBox      `json:"box,omitempty"`
	// Points are [dx, dy] or [dx, dy, pressure], in CSS pixels from Box's corner.
	Points   [][]float64     `json:"points" jsonschema:"[dx, dy] or [dx, dy, pressure 0..1] in CSS px from the anchor box's corner; at most 3000"`
	Color    string          `json:"color,omitempty"`
	Width    float64         `json:"width,omitempty"`
	Elements []StrokeElement `json:"elements,omitempty" jsonschema:"Elements under the stroke, at most 20"`
}

// StrokeViewport is the frame's size and scroll when the drawing was made.
type StrokeViewport struct {
	W       float64 `json:"w"`
	H       float64 `json:"h"`
	ScrollX float64 `json:"scroll_x"`
	ScrollY float64 `json:"scroll_y"`
}

// StrokeBox is the anchor element's box in document coordinates when the drawing was made.
type StrokeBox struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
	W float64 `json:"w"`
	H float64 `json:"h"`
}

// StrokeElement is one element the stroke passed over.
type StrokeElement struct {
	Path string `json:"path"`
	Tag  string `json:"tag,omitempty"`
	Text string `json:"text,omitempty"`
}

const (
	maxStrokePoints   = 3000
	maxStrokeElements = 20
	maxStrokeBytes    = 96 << 10
	maxElementText    = 120
)

var errStrokeTooLarge = errors.New("stroke too large")

// checkStroke validates a stroke from a client and returns the copy to store.
func checkStroke(in *Stroke) (*Stroke, error) {
	st := *in
	if st.V == 0 {
		st.V = 1
	}
	if st.V != 1 {
		return nil, errors.New("stroke v must be 1")
	}
	if len(st.Points) == 0 {
		return nil, errors.New("stroke needs points")
	}
	if len(st.Points) > maxStrokePoints || len(st.Elements) > maxStrokeElements {
		return nil, errStrokeTooLarge
	}
	for _, p := range st.Points {
		if len(p) < 2 || len(p) > 3 || len(p) == 3 && (p[2] < 0 || p[2] > 1) {
			return nil, errors.New("each stroke point is [dx, dy] or [dx, dy, pressure from 0 to 1]")
		}
	}
	if len(st.Anchor) > 2000 {
		return nil, errors.New("stroke anchor is at most 2000 bytes")
	}
	for _, e := range st.Elements {
		if utf8.RuneCountInString(e.Text) > maxElementText {
			return nil, errStrokeTooLarge
		}
	}
	if b, err := json.Marshal(st); err != nil || len(b) > maxStrokeBytes {
		return nil, errStrokeTooLarge
	}
	return &st, nil
}
