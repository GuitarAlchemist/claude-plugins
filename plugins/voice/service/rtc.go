package main

import (
	"bytes"
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pion/webrtc/v4"
)

//go:embed rtc.html
var rtcPage []byte

// RTC runs full-duplex voice sessions over WebRTC data channels, one per peer: the peer sends
// its microphone as 16-bit mono PCM and JSON requests, the service sends back synthesized
// speech as PCM and JSON events (sentences, speech boundaries, transcripts). Nothing is played
// on the local speaker. Peer connections are host-only (no STUN, no TURN): the only way to
// reach the offer endpoint is the loopback HTTP service, so the peer is on this machine.
//
// The channel is named "voice". A text message is one JSON object with a "type"; a binary
// message is PCM. From the peer: hello {sample_rate}, say {text, voice?, rate?}, flush, stop.
// From the service: ready {sample_rate, voice, transcriber}, sentence {id, n, ms, sample_rate}
// followed by that sentence's PCM, said {id, sentences, stopped}, speech {state: start|end,
// ms?}, transcript {text, ms, took_ms}, error {error}.
type RTC struct {
	Engines      func(v Voice, rate float64) (Engine, error)
	Voices       []Voice
	DefaultVoice string
	SampleRate   int // of the default voice, announced in ready
	MaxText      int
	MaxPeers     int
	Transcriber  Transcriber // nil: a transcript request is answered with an error event
	Log          *log.Logger

	once  sync.Once
	api   *webrtc.API
	mu    sync.Mutex
	peers map[*webrtc.PeerConnection]struct{}
}

func (r *RTC) init() {
	r.once.Do(func() {
		se := webrtc.SettingEngine{}
		se.SetIncludeLoopbackCandidate(true)
		r.api = webrtc.NewAPI(webrtc.WithSettingEngine(se))
		r.peers = map[*webrtc.PeerConnection]struct{}{}
		if r.MaxPeers <= 0 {
			r.MaxPeers = 4
		}
	})
}

func (r *RTC) transcriberName() string {
	if r.Transcriber == nil {
		return ""
	}
	return r.Transcriber.Name()
}

// page serves the test page that drives a session from a browser on this machine.
func (r *RTC) page(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	_, _ = w.Write(rtcPage)
}

// offer answers one SDP offer with an SDP answer, candidates included (no trickle).
func (r *RTC) offer(w http.ResponseWriter, req *http.Request) {
	r.init()
	var in struct {
		Type string `json:"type,omitempty"`
		SDP  string `json:"sdp"`
	}
	if err := decodeStrict(w, req, &in); err != nil {
		writeError(w, http.StatusBadRequest, "the body is not an offer: "+err.Error())
		return
	}
	if in.SDP == "" || in.Type != "" && in.Type != "offer" {
		writeError(w, http.StatusBadRequest, "the body is not an offer: want {\"sdp\": ...}")
		return
	}
	r.mu.Lock()
	if len(r.peers) >= r.MaxPeers {
		r.mu.Unlock()
		writeError(w, http.StatusServiceUnavailable, fmt.Sprintf("%d peers are connected; the limit is %d", len(r.peers), r.MaxPeers))
		return
	}
	pc, err := r.api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		r.mu.Unlock()
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	r.peers[pc] = struct{}{}
	r.mu.Unlock()
	drop := func() {
		r.mu.Lock()
		delete(r.peers, pc)
		r.mu.Unlock()
		_ = pc.Close()
	}
	pc.OnConnectionStateChange(func(s webrtc.PeerConnectionState) {
		r.Log.Printf("rtc: peer %s", s)
		switch s {
		case webrtc.PeerConnectionStateFailed, webrtc.PeerConnectionStateClosed, webrtc.PeerConnectionStateDisconnected:
			drop()
		}
	})
	pc.OnDataChannel(func(dc *webrtc.DataChannel) {
		if dc.Label() != "voice" {
			r.Log.Printf("rtc: closing channel %q: only \"voice\" is served", dc.Label())
			_ = dc.Close()
			return
		}
		newRTCConn(r, dc)
	})
	if err := pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: in.SDP}); err != nil {
		drop()
		writeError(w, http.StatusBadRequest, "the offer is refused: "+err.Error())
		return
	}
	answer, err := pc.CreateAnswer(nil)
	if err != nil {
		drop()
		writeError(w, http.StatusBadRequest, "no answer to this offer: "+err.Error())
		return
	}
	gathered := webrtc.GatheringCompletePromise(pc)
	if err := pc.SetLocalDescription(answer); err != nil {
		drop()
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	select {
	case <-gathered:
	case <-time.After(5 * time.Second):
		drop()
		writeError(w, http.StatusGatewayTimeout, "gathering the local candidates took more than 5 s")
		return
	case <-req.Context().Done():
		drop()
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"type": "answer", "sdp": pc.LocalDescription().SDP})
}

// Close ends every session.
func (r *RTC) Close() {
	r.mu.Lock()
	peers := r.peers
	r.peers = map[*webrtc.PeerConnection]struct{}{}
	r.mu.Unlock()
	for pc := range peers {
		_ = pc.Close()
	}
}

// rtcMessage is what the peer sends as text.
type rtcMessage struct {
	Type       string   `json:"type"`
	SampleRate int      `json:"sample_rate,omitempty"` // hello
	Text       string   `json:"text,omitempty"`        // say
	Voice      string   `json:"voice,omitempty"`       // say
	Rate       *float64 `json:"rate,omitempty"`        // say: speed
}

// rtcEvent is what the service sends as text.
type rtcEvent struct {
	Type        string `json:"type"`
	SampleRate  int    `json:"sample_rate,omitempty"`
	Voice       string `json:"voice,omitempty"`
	Transcriber string `json:"transcriber,omitempty"`
	ID          string `json:"id,omitempty"`
	N           int    `json:"n,omitempty"`
	Sentences   *int   `json:"sentences,omitempty"`
	Stopped     *bool  `json:"stopped,omitempty"`
	State       string `json:"state,omitempty"`
	Ms          *int64 `json:"ms,omitempty"`
	TookMs      *int64 `json:"took_ms,omitempty"`
	Text        string `json:"text,omitempty"`
	Error       string `json:"error,omitempty"`
}

type saying struct {
	cancel context.CancelFunc
	done   chan struct{}
}

// rtcConn is one voice channel.
type rtcConn struct {
	r   *RTC
	dc  *webrtc.DataChannel
	ctx context.Context
	end context.CancelFunc
	seq atomic.Uint64

	sendMu sync.Mutex
	low    chan struct{}

	micMu sync.Mutex
	mic   *Resampler
	ep    *Endpointer

	segments chan []byte

	sayMu  sync.Mutex
	saying *saying
}

var rtcSeq atomic.Uint64

func newRTCConn(r *RTC, dc *webrtc.DataChannel) *rtcConn {
	ctx, end := context.WithCancel(context.Background())
	c := &rtcConn{r: r, dc: dc, ctx: ctx, end: end, low: make(chan struct{}, 1),
		ep: NewEndpointer(sttRate), segments: make(chan []byte, 8)}
	id := rtcSeq.Add(1)
	dc.SetBufferedAmountLowThreshold(256 << 10)
	dc.OnBufferedAmountLow(func() {
		select {
		case c.low <- struct{}{}:
		default:
		}
	})
	dc.OnOpen(func() {
		r.Log.Printf("rtc: session %d open", id)
		c.send(rtcEvent{Type: "ready", SampleRate: r.SampleRate, Voice: r.DefaultVoice, Transcriber: r.transcriberName()})
	})
	dc.OnClose(func() {
		r.Log.Printf("rtc: session %d closed", id)
		c.stop()
		end()
	})
	dc.OnMessage(func(m webrtc.DataChannelMessage) {
		if m.IsString {
			c.control(m.Data)
		} else {
			c.audio(m.Data)
		}
	})
	go c.transcribe()
	return c
}

func (c *rtcConn) send(ev rtcEvent) {
	b, _ := json.Marshal(ev)
	c.sendMu.Lock()
	defer c.sendMu.Unlock()
	if err := c.dc.SendText(string(b)); err != nil {
		c.r.Log.Printf("rtc: send %s: %v", ev.Type, err)
	}
}

func (c *rtcConn) fail(msg string) { c.send(rtcEvent{Type: "error", Error: msg}) }

// sendPCM writes pcm in pieces the channel takes, waiting while the peer is behind. It returns
// false once ctx is done.
func (c *rtcConn) sendPCM(ctx context.Context, pcm []byte) bool {
	const piece = 16 << 10
	for len(pcm) > 0 {
		for c.dc.BufferedAmount() > 1<<20 {
			select {
			case <-c.low:
			case <-ctx.Done():
				return false
			case <-time.After(100 * time.Millisecond):
			}
		}
		if ctx.Err() != nil {
			return false
		}
		n := min(piece, len(pcm))
		c.sendMu.Lock()
		err := c.dc.Send(pcm[:n])
		c.sendMu.Unlock()
		if err != nil {
			c.r.Log.Printf("rtc: send pcm: %v", err)
			return false
		}
		pcm = pcm[n:]
	}
	return true
}

func (c *rtcConn) control(data []byte) {
	var m rtcMessage
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&m); err != nil {
		c.fail("not a voice message: " + err.Error())
		return
	}
	switch m.Type {
	case "hello":
		if m.SampleRate < 8000 || m.SampleRate > 96000 {
			c.fail("hello: sample_rate must be between 8000 and 96000")
			return
		}
		c.micMu.Lock()
		c.mic = &Resampler{From: m.SampleRate, To: sttRate}
		c.micMu.Unlock()
	case "say":
		c.say(m)
	case "flush":
		c.micMu.Lock()
		cut, ok := c.ep.Flush()
		c.micMu.Unlock()
		if ok {
			c.enqueue(cut.PCM)
		}
	case "stop":
		c.stop()
	default:
		c.fail(fmt.Sprintf("unknown message type %q; known: hello, say, flush, stop", m.Type))
	}
}

// audio takes one piece of the microphone.
func (c *rtcConn) audio(data []byte) {
	c.micMu.Lock()
	if c.mic == nil {
		c.micMu.Unlock()
		c.fail("audio before hello: send {\"type\":\"hello\",\"sample_rate\":N} first")
		return
	}
	cuts := c.ep.Feed(c.mic.Feed(data))
	c.micMu.Unlock()
	for _, cut := range cuts {
		if cut.Start {
			c.send(rtcEvent{Type: "speech", State: "start"})
			continue
		}
		c.enqueue(cut.PCM)
	}
}

func (c *rtcConn) enqueue(pcm []byte) {
	ms := audioMs(pcm, sttRate)
	c.send(rtcEvent{Type: "speech", State: "end", Ms: &ms})
	select {
	case c.segments <- pcm:
	default:
		c.fail(fmt.Sprintf("transcription is behind; %d ms of speech dropped", ms))
	}
}

// transcribe runs the utterances in order, one at a time.
func (c *rtcConn) transcribe() {
	for {
		var pcm []byte
		select {
		case <-c.ctx.Done():
			return
		case pcm = <-c.segments:
		}
		if c.r.Transcriber == nil {
			c.fail("no transcriber: start the service with whisper installed (see --whisper)")
			continue
		}
		t := time.Now()
		text, err := c.r.Transcriber.Transcribe(c.ctx, pcm)
		if err != nil {
			if c.ctx.Err() == nil {
				c.r.Log.Printf("rtc: transcribe: %v", err)
				c.fail(err.Error())
			}
			continue
		}
		ms, took := audioMs(pcm, sttRate), time.Since(t).Milliseconds()
		c.r.Log.Printf("rtc: transcript (%d ms of speech in %d ms): %s", ms, took, text)
		c.send(rtcEvent{Type: "transcript", Text: text, Ms: &ms, TookMs: &took})
	}
}

// say synthesizes m.Text sentence by sentence into the channel, cutting any say under way.
func (c *rtcConn) say(m rtcMessage) {
	if code, msg := checkText(m.Text, c.r.MaxText); code != 0 {
		c.fail(msg)
		return
	}
	v, rate, err := pickVoice(c.r.Voices, c.r.DefaultVoice, m.Voice, m.Rate)
	if err != nil {
		c.fail(err.Error())
		return
	}
	sentences := Sentences(m.Text)
	if len(sentences) == 0 {
		c.fail("nothing to say once the markup is removed")
		return
	}
	eng, err := c.r.Engines(v, rate)
	if err != nil {
		c.fail(err.Error())
		return
	}
	c.stop()
	ctx, cancel := context.WithCancel(c.ctx)
	s := &saying{cancel: cancel, done: make(chan struct{})}
	c.sayMu.Lock()
	c.saying = s
	c.sayMu.Unlock()
	id := fmt.Sprintf("r%d", c.seq.Add(1))
	go func() {
		defer close(s.done)
		sent := 0
		for i, t := range sentences {
			if ctx.Err() != nil {
				break
			}
			start := time.Now()
			pcm, err := eng.Synthesize(ctx, t)
			if err != nil {
				if ctx.Err() == nil {
					c.r.Log.Printf("rtc: %s: sentence %d: %v", id, i+1, err)
					c.fail(fmt.Sprintf("%s: sentence %d: %v", id, i+1, err))
				}
				break
			}
			ms := audioMs(pcm, eng.SampleRate())
			c.r.Log.Printf("rtc: %s: sentence %d synthesized in %d ms (%d ms of audio)", id, i+1, time.Since(start).Milliseconds(), ms)
			c.send(rtcEvent{Type: "sentence", ID: id, N: i + 1, Ms: &ms, SampleRate: eng.SampleRate()})
			if !c.sendPCM(ctx, pcm) {
				break
			}
			sent++
		}
		stopped := ctx.Err() != nil && c.ctx.Err() == nil
		if c.ctx.Err() == nil {
			c.send(rtcEvent{Type: "said", ID: id, Sentences: &sent, Stopped: &stopped})
		}
	}()
}

// stop cuts the say under way, if any, and waits for it to be gone.
func (c *rtcConn) stop() {
	c.sayMu.Lock()
	s := c.saying
	c.saying = nil
	c.sayMu.Unlock()
	if s != nil {
		s.cancel()
		<-s.done
	}
}

var errNoVoice = errors.New("no voice")

// pickVoice resolves a voice id (empty for the default) and a speed (nil for 1).
func pickVoice(voices []Voice, def, id string, rate *float64) (Voice, float64, error) {
	if id == "" {
		id = def
	}
	v, ok := findVoice(voices, id)
	if !ok {
		return Voice{}, 0, fmt.Errorf("%w %q; installed: %s", errNoVoice, id, voiceIDs(voices))
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
