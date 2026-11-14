package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

// Server answers the HTTP contract (v0.2) on a loopback address.
type Server struct {
	Speaker *Speaker
	// Engines gives /v1/synthesize its engine; playback goes through Speaker instead.
	Engines      func(v Voice, rate float64) (Engine, error)
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

type synthesizeRequest struct {
	Text  string   `json:"text"`
	Voice string   `json:"voice,omitempty"`
	Rate  *float64 `json:"rate,omitempty"`
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
	mux.HandleFunc("POST /v1/say/stream", s.sayStream)
	mux.HandleFunc("POST /v1/synthesize", s.synthesize)
	mux.HandleFunc("POST /v1/stop", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]int{"stopped": s.Speaker.Stop()})
	})
	return localOnly(mux)
}

func (s *Server) health(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "version": version, "engine": s.Engine,
		"voice": s.DefaultVoice, "sample_rate": s.SampleRate})
}

// pick resolves a voice id (empty for the default) and a rate (nil for 1).
func (s *Server) pick(id string, rate *float64) (Voice, float64, error) {
	if id == "" {
		id = s.DefaultVoice
	}
	v, ok := findVoice(s.Voices, id)
	if !ok {
		return Voice{}, 0, fmt.Errorf("no voice %q; installed: %s", id, voiceIDs(s.Voices))
	}
	r := 1.0
	if rate != nil {
		r = *rate
	}
	if !(r >= 0.5 && r <= 2) {
		return Voice{}, 0, errors.New("rate must be between 0.5 and 2")
	}
	return v, r, nil
}

// checkText answers the status and message that refuse text, or 0 when it is fine.
func (s *Server) checkText(text string) (int, string) {
	if strings.TrimSpace(text) == "" {
		return http.StatusBadRequest, "text is empty"
	}
	if n := utf8.RuneCountInString(text); n > s.MaxText {
		return http.StatusRequestEntityTooLarge, fmt.Sprintf("text has %d characters; the limit is %d", n, s.MaxText)
	}
	return 0, ""
}

func decodeStrict(w http.ResponseWriter, r *http.Request, into any) error {
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	dec.DisallowUnknownFields()
	return dec.Decode(into)
}

func (s *Server) say(w http.ResponseWriter, r *http.Request) {
	var req sayRequest
	if err := decodeStrict(w, r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "the body is not a say request: "+err.Error())
		return
	}
	if code, msg := s.checkText(req.Text); code != 0 {
		writeError(w, code, msg)
		return
	}
	v, rate, err := s.pick(req.Voice, req.Rate)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
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
	s.answer(w, r, u, len(sentences), req.Wait)
}

// sayStream speaks a text body as it arrives: each sentence is queued as soon as it is
// complete, so the first one plays while the caller is still writing the rest.
func (s *Server) sayStream(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	for k := range q {
		if k != "voice" && k != "rate" && k != "wait" {
			writeError(w, http.StatusBadRequest, fmt.Sprintf("unknown parameter %q; known: voice, rate, wait", k))
			return
		}
	}
	var rate *float64
	if q.Has("rate") {
		f, err := strconv.ParseFloat(q.Get("rate"), 64)
		if err != nil {
			writeError(w, http.StatusBadRequest, "rate is not a number")
			return
		}
		rate = &f
	}
	wait := false
	if q.Has("wait") {
		b, err := strconv.ParseBool(q.Get("wait"))
		if err != nil {
			writeError(w, http.StatusBadRequest, "wait must be true or false (or 1 or 0)")
			return
		}
		wait = b
	}
	v, rt, err := s.pick(q.Get("voice"), rate)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	u, err := s.Speaker.Begin(v, rt, 64)
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, err.Error())
		return
	}
	body := http.MaxBytesReader(w, r.Body, int64(s.MaxText)*utf8.UTFMax+4096)
	var sp Splitter
	var carry []byte
	buf := make([]byte, 4096)
	runes, sentences, open := 0, 0, true
	feed := func(parts []string) {
		for _, t := range parts {
			if open = u.Add(t); !open {
				return // stopped by /v1/stop
			}
			sentences++
		}
	}
	for open {
		n, rerr := body.Read(buf)
		if n > 0 {
			carry = append(carry, buf[:n]...)
			cut := completeRunes(carry)
			chunk := string(carry[:cut])
			carry = append([]byte(nil), carry[cut:]...)
			if runes += utf8.RuneCountInString(chunk); runes > s.MaxText {
				u.Stop()
				u.End()
				writeError(w, http.StatusRequestEntityTooLarge, fmt.Sprintf("the stream passed the limit of %d characters; this utterance is stopped", s.MaxText))
				return
			}
			feed(sp.Feed(chunk))
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			u.Stop()
			u.End()
			writeError(w, http.StatusBadRequest, "reading the body: "+rerr.Error())
			return
		}
	}
	if open {
		feed(append(sp.Feed(string(carry)), sp.Flush()...))
	}
	u.End()
	if sentences == 0 && open {
		writeError(w, http.StatusBadRequest, "nothing to say once the markup is removed")
		return
	}
	s.answer(w, r, u, sentences, wait)
}

// completeRunes is the length of the longest prefix of b that does not end inside a UTF-8
// sequence, so a read that splits a character keeps its first bytes for the next read.
func completeRunes(b []byte) int {
	for i := len(b) - 1; i >= 0 && i >= len(b)-utf8.UTFMax; i-- {
		if utf8.RuneStart(b[i]) {
			if utf8.FullRune(b[i:]) {
				return len(b)
			}
			return i
		}
	}
	return len(b)
}

// answer replies to a say request at once, or with wait once the utterance has ended.
func (s *Server) answer(w http.ResponseWriter, r *http.Request, u *Utterance, sentences int, wait bool) {
	if !wait {
		writeJSON(w, http.StatusOK, sayAnswer{ID: u.ID, Sentences: sentences})
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
	writeJSON(w, http.StatusOK, sayAnswer{ID: u.ID, Sentences: sentences, PlayedMs: &played, Stopped: &stopped})
}

// synthesize streams the text as WAV, sentence by sentence as each is made, without playing
// it. A failure after the header has gone out ends the stream early and is named in the
// X-Voice-Error trailer.
func (s *Server) synthesize(w http.ResponseWriter, r *http.Request) {
	var req synthesizeRequest
	if err := decodeStrict(w, r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "the body is not a synthesize request: "+err.Error())
		return
	}
	if code, msg := s.checkText(req.Text); code != 0 {
		writeError(w, code, msg)
		return
	}
	v, rate, err := s.pick(req.Voice, req.Rate)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	sentences := Sentences(req.Text)
	if len(sentences) == 0 {
		writeError(w, http.StatusBadRequest, "nothing to say once the markup is removed")
		return
	}
	eng, err := s.Engines(v, rate)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	w.Header().Set("Content-Type", "audio/wav")
	w.Header().Set("X-Sentences", strconv.Itoa(len(sentences)))
	w.Header().Set("Trailer", "X-Voice-Error")
	w.WriteHeader(http.StatusOK)
	flusher, _ := w.(http.Flusher)
	flush := func() {
		if flusher != nil {
			flusher.Flush()
		}
	}
	if _, err := w.Write(streamingWAVHeader(eng.SampleRate())); err != nil {
		return
	}
	flush()
	for i, t := range sentences {
		if r.Context().Err() != nil {
			return
		}
		start := time.Now()
		pcm, err := eng.Synthesize(r.Context(), t)
		if err != nil {
			s.Speaker.log.Printf("synthesize: sentence %d: %v", i+1, err)
			w.Header().Set("X-Voice-Error", fmt.Sprintf("sentence %d: %v", i+1, err))
			return
		}
		s.Speaker.log.Printf("synthesize: sentence %d synthesized in %d ms (%d ms of audio)", i+1, time.Since(start).Milliseconds(), audioMs(pcm, eng.SampleRate()))
		if _, err := w.Write(pcm); err != nil {
			return
		}
		flush()
	}
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
