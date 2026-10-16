package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"strings"
	"unicode/utf8"
)

// Server answers the HTTP contract (v0.1) on a loopback address.
type Server struct {
	Speaker      *Speaker
	Voices       []Voice
	DefaultVoice string
	Engine       string
	SampleRate   int
	MaxText      int
}

type sayRequest struct {
	Text  string   `json:"text"`
	Voice string   `json:"voice,omitempty"`
	Rate  *float64 `json:"rate,omitempty"`
	Wait  bool     `json:"wait,omitempty"`
}

type sayAnswer struct {
	ID        string `json:"id"`
	Sentences int    `json:"sentences"`
	PlayedMs  *int64 `json:"played_ms,omitempty"`
	Stopped   *bool  `json:"stopped,omitempty"`
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", s.health)
	mux.HandleFunc("GET /v1/voices", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, s.Voices)
	})
	mux.HandleFunc("POST /v1/say", s.say)
	mux.HandleFunc("POST /v1/stop", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]int{"stopped": s.Speaker.Stop()})
	})
	return localOnly(mux)
}

func (s *Server) health(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "version": version, "engine": s.Engine,
		"voice": s.DefaultVoice, "sample_rate": s.SampleRate})
}

func (s *Server) say(w http.ResponseWriter, r *http.Request) {
	var req sayRequest
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "the body is not a say request: "+err.Error())
		return
	}
	if strings.TrimSpace(req.Text) == "" {
		writeError(w, http.StatusBadRequest, "text is empty")
		return
	}
	if n := utf8.RuneCountInString(req.Text); n > s.MaxText {
		writeError(w, http.StatusRequestEntityTooLarge, fmt.Sprintf("text has %d characters; the limit is %d", n, s.MaxText))
		return
	}
	id := req.Voice
	if id == "" {
		id = s.DefaultVoice
	}
	v, ok := findVoice(s.Voices, id)
	if !ok {
		writeError(w, http.StatusBadRequest, fmt.Sprintf("no voice %q; installed: %s", id, voiceIDs(s.Voices)))
		return
	}
	rate := 1.0
	if req.Rate != nil {
		rate = *req.Rate
	}
	if rate < 0.5 || rate > 2 {
		writeError(w, http.StatusBadRequest, "rate must be between 0.5 and 2")
		return
	}
	sentences := Sentences(req.Text)
	if len(sentences) == 0 {
		writeError(w, http.StatusBadRequest, "nothing to say once the markup is removed")
		return
	}
	u, err := s.Speaker.Begin(v, rate, len(sentences))
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, err.Error())
		return
	}
	for _, t := range sentences {
		u.Add(t)
	}
	u.End()
	if !req.Wait {
		writeJSON(w, http.StatusOK, sayAnswer{ID: u.ID, Sentences: len(sentences)})
		return
	}
	select {
	case <-u.Done():
	case <-r.Context().Done():
		return
	}
	if err := u.Err(); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	played, stopped := u.PlayedMs(), u.Stopped()
	writeJSON(w, http.StatusOK, sayAnswer{ID: u.ID, Sentences: len(sentences), PlayedMs: &played, Stopped: &stopped})
}

// localOnly refuses requests a web page could make: any request with an Origin header, and any
// whose Host is not a loopback name, which is what a DNS-rebinding page would send.
func localOnly(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Origin") != "" {
			writeError(w, http.StatusForbidden, "requests from web pages are refused")
			return
		}
		host := r.Host
		if h, _, err := net.SplitHostPort(r.Host); err == nil {
			host = h
		}
		host = strings.Trim(host, "[]")
		if ip := net.ParseIP(host); !(host == "localhost" || ip != nil && ip.IsLoopback()) {
			writeError(w, http.StatusForbidden, "only loopback hosts are served")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

// loopbackOnly refuses a listen address that is not on a loopback interface.
func loopbackOnly(addr string) error {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return err
	}
	if ip := net.ParseIP(host); host == "localhost" || ip != nil && ip.IsLoopback() {
		return nil
	}
	return errors.New("the service listens on loopback only: use 127.0.0.1:<port>")
}
