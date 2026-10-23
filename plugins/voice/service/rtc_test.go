package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
)

type fakeTranscriber struct {
	mu   sync.Mutex
	seen [][]byte
}

func (f *fakeTranscriber) Name() string { return "fake" }

func (f *fakeTranscriber) Transcribe(_ context.Context, pcm []byte) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.seen = append(f.seen, pcm)
	return fmt.Sprintf("heard %d ms", audioMs(pcm, sttRate)), nil
}

// rtcServer serves a fake engine whose sentences take synth to make.
func rtcServer(t *testing.T, tr Transcriber, synth time.Duration) (*httptest.Server, *recorder) {
	t.Helper()
	rec := &recorder{}
	eng := &fakeEngine{rec: rec, delay: synth}
	engines := func(Voice, float64) (Engine, error) { return eng, nil }
	s := &Server{Speaker: testSpeaker(&recorder{}, 0, 0), Voices: []Voice{testVoice}, DefaultVoice: testVoice.ID,
		Engines: engines, Engine: "fake", SampleRate: testRate, MaxText: 50,
		RTC: &RTC{Engines: engines, Voices: []Voice{testVoice}, DefaultVoice: testVoice.ID, SampleRate: testRate,
			MaxText: 50, Transcriber: tr, Log: log.New(io.Discard, "", 0)}}
	ts := httptest.NewServer(s.Handler())
	t.Cleanup(func() { s.RTC.Close(); s.Speaker.Stop(); ts.Close() })
	return ts, rec
}

// peer is the test's side of a session.
type peer struct {
	pc   *webrtc.PeerConnection
	dc   *webrtc.DataChannel
	msgs chan webrtc.DataChannelMessage
}

// dial opens a voice channel to ts the way the served page does, with its own origin.
func dial(t *testing.T, ts *httptest.Server) *peer {
	t.Helper()
	pc, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { pc.Close() })
	dc, err := pc.CreateDataChannel("voice", nil)
	if err != nil {
		t.Fatal(err)
	}
	p := &peer{pc: pc, dc: dc, msgs: make(chan webrtc.DataChannelMessage, 1024)}
	opened := make(chan struct{})
	dc.OnOpen(func() { close(opened) })
	dc.OnMessage(func(m webrtc.DataChannelMessage) { p.msgs <- m })
	offer, err := pc.CreateOffer(nil)
	if err != nil {
		t.Fatal(err)
	}
	gathered := webrtc.GatheringCompletePromise(pc)
	if err := pc.SetLocalDescription(offer); err != nil {
		t.Fatal(err)
	}
	<-gathered
	body, _ := json.Marshal(map[string]string{"type": "offer", "sdp": pc.LocalDescription().SDP})
	code, a := do(t, ts, "POST", "/v1/rtc/offer", string(body), func(r *http.Request) { r.Header.Set("Origin", ts.URL) })
	if code != 200 || a["type"] != "answer" {
		t.Fatalf("offer: %d %v", code, a)
	}
	if err := pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: a["sdp"].(string)}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-opened:
	case <-time.After(10 * time.Second):
		t.Fatal("the channel did not open in 10 s")
	}
	return p
}

func (p *peer) sendJSON(t *testing.T, v any) {
	t.Helper()
	b, _ := json.Marshal(v)
	if err := p.dc.SendText(string(b)); err != nil {
		t.Fatal(err)
	}
}

// event waits for the next text message, which must be of type typ.
func (p *peer) event(t *testing.T, typ string) rtcEvent {
	t.Helper()
	for {
		select {
		case m := <-p.msgs:
			if !m.IsString {
				t.Fatalf("waiting for %s: got %d bytes of audio", typ, len(m.Data))
			}
			var ev rtcEvent
			if err := json.Unmarshal(m.Data, &ev); err != nil {
				t.Fatalf("waiting for %s: %v: %s", typ, err, m.Data)
			}
			if ev.Type != typ {
				t.Fatalf("waiting for %s: got %s", typ, m.Data)
			}
			return ev
		case <-time.After(10 * time.Second):
			t.Fatalf("no %s event in 10 s", typ)
		}
	}
}

// audio collects binary messages until the next text one, which is returned too.
func (p *peer) audio(t *testing.T) ([]byte, rtcEvent) {
	t.Helper()
	var pcm []byte
	for {
		select {
		case m := <-p.msgs:
			if !m.IsString {
				pcm = append(pcm, m.Data...)
				continue
			}
			var ev rtcEvent
			if err := json.Unmarshal(m.Data, &ev); err != nil {
				t.Fatal(err)
			}
			return pcm, ev
		case <-time.After(10 * time.Second):
			t.Fatal("no event after the audio in 10 s")
		}
	}
}

func TestRTCSpeaksAndHearsOverOneChannel(t *testing.T) {
	tr := &fakeTranscriber{}
	ts, _ := rtcServer(t, tr, 0)
	p := dial(t, ts)
	if ev := p.event(t, "ready"); ev.SampleRate != testRate || ev.Voice != testVoice.ID || ev.Transcriber != "fake" {
		t.Fatalf("ready: %+v", ev)
	}

	// audio before hello is refused
	p.dc.Send(make([]byte, 640))
	if ev := p.event(t, "error"); !strings.Contains(ev.Error, "before hello") {
		t.Fatalf("%+v", ev)
	}
	p.sendJSON(t, map[string]any{"type": "hello", "sample_rate": 48000})

	// speech out: the fake engine's "audio" is the sentence's own bytes
	p.sendJSON(t, map[string]any{"type": "say", "text": "Un. Deux."})
	s1 := p.event(t, "sentence")
	pcm, s2 := p.audio(t)
	if s1.N != 1 || s1.SampleRate != testRate || string(pcm) != "Un." || s2.Type != "sentence" || s2.N != 2 || s2.ID != s1.ID {
		t.Fatalf("sentence 1: %+v %q then %+v", s1, pcm, s2)
	}
	pcm, said := p.audio(t)
	if string(pcm) != "Deux." || said.Type != "said" || *said.Sentences != 2 || *said.Stopped || said.ID != s1.ID {
		t.Fatalf("sentence 2: %q then %+v", pcm, said)
	}

	// speech in, at the peer's rate: 600 ms of tone then a second of silence, in 20 ms pieces
	mic := append(sine(48000, 600*time.Millisecond, 0.3), silence(48000, time.Second)...)
	for len(mic) > 0 {
		n := min(1920, len(mic))
		if err := p.dc.Send(mic[:n]); err != nil {
			t.Fatal(err)
		}
		mic = mic[n:]
	}
	if ev := p.event(t, "speech"); ev.State != "start" {
		t.Fatalf("%+v", ev)
	}
	// 600 ms of speech (no lead: nothing quiet came before it) and the 300 ms of silence kept after it
	end := p.event(t, "speech")
	if end.State != "end" || *end.Ms < 860 || *end.Ms > 980 {
		t.Fatalf("end: %s after %d ms", end.State, *end.Ms)
	}
	tsc := p.event(t, "transcript")
	if tsc.Text != fmt.Sprintf("heard %d ms", *end.Ms) || *tsc.Ms != *end.Ms || tsc.TookMs == nil {
		t.Fatalf("transcript: %+v", tsc)
	}
	tr.mu.Lock()
	n := len(tr.seen)
	tr.mu.Unlock()
	if n != 1 {
		t.Fatalf("%d utterances transcribed", n)
	}

	// flush closes a short utterance that silence has not closed yet
	p.dc.Send(sine(48000, 400*time.Millisecond, 0.3))
	p.event(t, "speech")
	p.sendJSON(t, map[string]any{"type": "flush"})
	if ev := p.event(t, "speech"); ev.State != "end" {
		t.Fatalf("%+v", ev)
	}
	p.event(t, "transcript")

	// refusals are events, not closures
	for _, m := range []map[string]any{
		{"type": "say", "text": "x", "volume": 3},
		{"type": "say", "text": "   "},
		{"type": "say", "text": strings.Repeat("é", 51)},
		{"type": "say", "text": "x", "voice": "nope"},
		{"type": "say", "text": "x", "rate": 3},
		{"type": "say", "text": "*** ##"},
		{"type": "hello", "sample_rate": 10},
		{"type": "dance"},
	} {
		p.sendJSON(t, m)
		if ev := p.event(t, "error"); ev.Error == "" {
			t.Fatalf("%v: %+v", m, ev)
		}
	}
	// the hello that failed did not replace the mic rate
	p.sendJSON(t, map[string]any{"type": "say", "text": "Trois."})
	p.event(t, "sentence")
	if _, ev := p.audio(t); ev.Type != "said" {
		t.Fatalf("%+v", ev)
	}
}

func TestRTCStopCutsTheSayUnderWay(t *testing.T) {
	// a slow engine: each sentence takes 150 ms to make
	ts, rec := rtcServer(t, nil, 150*time.Millisecond)
	p := dial(t, ts)
	p.event(t, "ready")
	p.sendJSON(t, map[string]any{"type": "hello", "sample_rate": 16000})
	p.sendJSON(t, map[string]any{"type": "say", "text": "Un. Deux. Trois. Quatre. Cinq. Six. Sept. Huit."})
	p.event(t, "sentence")
	p.sendJSON(t, map[string]any{"type": "stop"})
	// the say ends as stopped, short of its eight sentences, and a new one runs from the start
	for {
		_, ev := p.audio(t)
		if ev.Type == "said" {
			if !*ev.Stopped || *ev.Sentences >= 8 {
				t.Fatalf("%+v", ev)
			}
			break
		}
		if ev.Type != "sentence" {
			t.Fatalf("%+v", ev)
		}
	}
	if rec.waitFor(t, "synth Deux."); slices.Contains(rec.all(), "synth Huit.") {
		t.Fatalf("the stopped say went on: %q", rec.all())
	}
	p.sendJSON(t, map[string]any{"type": "say", "text": "Neuf."})
	if ev := p.event(t, "sentence"); ev.N != 1 {
		t.Fatalf("%+v", ev)
	}
	// no transcriber: speech is answered with an error, not silence
	p.dc.Send(sine(16000, 500*time.Millisecond, 0.3))
	p.sendJSON(t, map[string]any{"type": "flush"})
	saw := map[string]bool{}
	for len(saw) < 4 {
		_, ev := p.audio(t)
		saw[ev.Type+ev.State+ev.Error] = true
		if ev.Type == "error" && !strings.Contains(ev.Error, "no transcriber") {
			t.Fatalf("%+v", ev)
		}
	}
	if !saw["said"] || !saw["speechstart"] || !saw["speechend"] {
		t.Fatalf("%v", saw)
	}
}

func TestRTCOfferIsLoopbackAndOwnOriginOnly(t *testing.T) {
	ts, _ := rtcServer(t, nil, 0)
	cases := map[string]struct {
		path, body string
		edit       func(*http.Request)
		code       int
		has        string
	}{
		"foreign origin":       {"/v1/rtc/offer", `{"sdp":"v=0"}`, func(r *http.Request) { r.Header.Set("Origin", "https://example.com") }, 403, "web pages"},
		"own origin elsewhere": {"/v1/say", `{"text":"x"}`, func(r *http.Request) { r.Header.Set("Origin", ts.URL) }, 403, "web pages"},
		"https own host":       {"/v1/rtc/offer", `{"sdp":"v=0"}`, func(r *http.Request) { r.Header.Set("Origin", strings.Replace(ts.URL, "http://", "https://", 1)) }, 403, "web pages"},
		"not an offer":         {"/v1/rtc/offer", `{"sdp":""}`, nil, 400, "not an offer"},
		"unknown field":        {"/v1/rtc/offer", `{"sdp":"v=0","ice":[]}`, nil, 400, "ice"},
		"bad sdp":              {"/v1/rtc/offer", `{"sdp":"v=0"}`, func(r *http.Request) { r.Header.Set("Origin", ts.URL) }, 400, "refused"},
	}
	for name, c := range cases {
		code, a := do(t, ts, "POST", c.path, c.body, c.edit)
		if msg, _ := a["error"].(string); code != c.code || !strings.Contains(msg, c.has) {
			t.Errorf("%s: %d %v, want %d with %q", name, code, a, c.code, c.has)
		}
	}
	resp, err := http.Get(ts.URL + "/rtc")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	page, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 || !bytes.Contains(page, []byte("createDataChannel('voice'")) || resp.Header.Get("Content-Security-Policy") == "" {
		t.Fatalf("page: %d %s", resp.StatusCode, resp.Header)
	}
	code, h := do(t, ts, "GET", "/health", "", nil)
	if code != 200 || h["rtc"] != true || h["transcriber"] != "" {
		t.Fatalf("health: %v", h)
	}
}

// TestWhisperHearsPiper is the round trip without a browser: Piper speaks a sentence, the
// endpointer cuts it the way it would cut a microphone, whisper transcribes it. It runs only
// where both are installed (the service's own setup and the voice-listen one).
func TestWhisperHearsPiper(t *testing.T) {
	if testing.Short() {
		t.Skip("-short")
	}
	cache, _ := os.UserCacheDir()
	exe, model, err := findWhisper(cache, "", "", "fr")
	if err != nil {
		t.Skip(err)
	}
	h, _ := home()
	voices, err := scanVoices(filepath.Join(h, "voices"))
	if err != nil {
		t.Skip(err)
	}
	v, ok := findVoice(voices, defaultVoc)
	if !ok {
		t.Skipf("no voice %s", defaultVoc)
	}
	piper := filepath.Join(h, "engine", "piper", "piper")
	if runtime.GOOS == "windows" {
		piper += ".exe"
	}
	if _, err := os.Stat(piper); err != nil {
		t.Skip(err)
	}
	tmp := t.TempDir()
	eng, err := startPiper(piper, nil, v, 1, tmp, log.New(io.Discard, "", 0))
	if err != nil {
		t.Fatal(err)
	}
	defer eng.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	const said = "Bonjour, je suis la voix de test et je compte jusqu'à trois : un, deux, trois."
	spoken, err := eng.Synthesize(ctx, said)
	if err != nil {
		t.Fatal(err)
	}
	rs := &Resampler{From: eng.SampleRate(), To: sttRate}
	ep := NewEndpointer(sttRate)
	var cuts []Cut
	for _, piece := range [][]byte{spoken, silence(eng.SampleRate(), time.Second)} {
		cuts = append(cuts, ep.Feed(rs.Feed(piece))...)
	}
	if len(cuts) != 2 || cuts[1].Start {
		t.Fatalf("the sentence was cut into %d pieces", len(cuts))
	}
	w, err := newWhisper(exe, model, "fr", tmp, 0)
	if err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	text, err := w.Transcribe(ctx, cuts[1].PCM)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("piper said %q (%d ms); whisper heard %q in %d ms", said, audioMs(cuts[1].PCM, sttRate), text, time.Since(start).Milliseconds())
	low := strings.ToLower(text)
	for _, words := range [][]string{{"bonjour"}, {"voix"}, {"trois", "3"}} { // whisper may write the number as a digit
		if !slices.ContainsFunc(words, func(w string) bool { return strings.Contains(low, w) }) {
			t.Errorf("%q is missing from %q", words[0], text)
		}
	}
}
