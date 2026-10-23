package main

import (
	"encoding/binary"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

type streamResult struct {
	code int
	body map[string]any
	err  error
}

// stream posts the pipe's reader to /v1/say/stream and returns the answer on a channel.
func stream(ts interface{ Client() *http.Client }, url string, body io.Reader) <-chan streamResult {
	out := make(chan streamResult, 1)
	go func() {
		req, err := http.NewRequest("POST", url, body)
		if err != nil {
			out <- streamResult{err: err}
			return
		}
		req.Header.Set("Content-Type", "text/plain; charset=utf-8")
		resp, err := ts.Client().Do(req)
		if err != nil {
			out <- streamResult{err: err}
			return
		}
		defer resp.Body.Close()
		var m map[string]any
		err = json.NewDecoder(resp.Body).Decode(&m)
		out <- streamResult{code: resp.StatusCode, body: m, err: err}
	}()
	return out
}

func TestStreamSpeaksTheFirstSentenceBeforeTheBodyEnds(t *testing.T) {
	ts, rec := testServer(t, 20*time.Millisecond)
	pr, pw := io.Pipe()
	answer := stream(ts, ts.URL+"/v1/say/stream?wait=1", pr)
	if _, err := io.WriteString(pw, "Un. Deux"); err != nil {
		t.Fatal(err)
	}
	rec.waitFor(t, "play Un.") // the body is still open
	rec.add("body ends")
	io.WriteString(pw, " trois.")
	pw.Close()
	got := <-answer
	if got.err != nil || got.code != 200 || got.body["sentences"] != float64(2) || got.body["stopped"] != false {
		t.Fatalf("answer: %+v", got)
	}
	if rec.index(t, "play Un.") > rec.index(t, "body ends") || rec.index(t, "play Deux trois.") < rec.index(t, "body ends") {
		t.Fatalf("order: %q", rec.all())
	}
}

func TestStreamKeepsACharacterSplitAcrossReads(t *testing.T) {
	ts, rec := testServer(t, 0)
	pr, pw := io.Pipe()
	answer := stream(ts, ts.URL+"/v1/say/stream?wait=true", pr)
	e := []byte("é")
	pw.Write([]byte("Caf"))
	pw.Write(e[:1])
	time.Sleep(30 * time.Millisecond)
	pw.Write(append(e[1:], []byte(" noir.")...))
	pw.Close()
	if got := <-answer; got.err != nil || got.code != 200 {
		t.Fatalf("answer: %+v", got)
	}
	rec.index(t, "play Café noir.")
}

func TestCompleteRunes(t *testing.T) {
	e := []byte("é") // 2 bytes
	h := []byte("😀") // 4 bytes
	for _, c := range []struct {
		in   []byte
		want int
	}{
		{[]byte("abc"), 3},
		{append([]byte("ab"), e[:1]...), 2},
		{append([]byte("ab"), e...), 4},
		{append([]byte("a"), h[:3]...), 1},
		{h, 4},
		{nil, 0},
	} {
		if got := completeRunes(c.in); got != c.want {
			t.Errorf("completeRunes(%q) = %d, want %d", c.in, got, c.want)
		}
	}
}

func TestStreamRefusals(t *testing.T) {
	ts, rec := testServer(t, 0)
	for name, c := range map[string]struct {
		query, body string
		code        int
		has         string
	}{
		"unknown parameter": {"?volume=3", "Un.", 400, "volume"},
		"rate":              {"?rate=fast", "Un.", 400, "rate"},
		"rate range":        {"?rate=9", "Un.", 400, "between"},
		"wait":              {"?wait=maybe", "Un.", 400, "wait"},
		"voice":             {"?voice=nope", "Un.", 400, "no voice"},
		"markup only":       {"", "*** ##", 400, "nothing to say"},
		"too long":          {"", strings.Repeat("a", 51), 413, "limit"},
	} {
		got := <-stream(ts, ts.URL+"/v1/say/stream"+c.query, strings.NewReader(c.body))
		if msg, _ := got.body["error"].(string); got.code != c.code || !strings.Contains(msg, c.has) {
			t.Errorf("%s: %+v, want %d with %q", name, got, c.code, c.has)
		}
	}
	if len(rec.all()) != 0 {
		t.Fatalf("a refused stream was played: %q", rec.all())
	}
}

func TestSynthesizeStreamsWAVWithoutPlaying(t *testing.T) {
	ts, rec := testServer(t, 0)
	resp, err := http.Post(ts.URL+"/v1/synthesize", "application/json", strings.NewReader(`{"text":"Un. Deux."}`))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(resp.Body)
	if err != nil || resp.StatusCode != 200 || resp.Header.Get("Content-Type") != "audio/wav" || resp.Header.Get("X-Sentences") != "2" {
		t.Fatalf("%d %v %v %s", resp.StatusCode, resp.Header, err, b)
	}
	if size := binary.LittleEndian.Uint32(b[40:44]); size != 0xFFFFFFFF {
		t.Fatalf("data size %x, want the streaming marker", size)
	}
	pcm, rate, err := parseWAV(b)
	if err != nil || rate != testRate || string(pcm) != "Un.Deux." {
		t.Fatalf("%q %d %v", pcm, rate, err)
	}
	if resp.Trailer.Get("X-Voice-Error") != "" {
		t.Fatalf("trailer: %v", resp.Trailer)
	}
	if len(rec.all()) != 0 {
		t.Fatalf("synthesize used the playback queue: %q", rec.all())
	}
}

func TestSynthesizeNamesAFailureInTheTrailer(t *testing.T) {
	ts, _ := testServer(t, 0)
	resp, err := http.Post(ts.URL+"/v1/synthesize", "application/json", strings.NewReader(`{"text":"Un. boom. Trois."}`))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	if pcm, _, _ := parseWAV(b); string(pcm) != "Un." {
		t.Fatalf("audio before the failure: %q", pcm)
	}
	if msg := resp.Trailer.Get("X-Voice-Error"); !strings.Contains(msg, "sentence 2") {
		t.Fatalf("trailer: %v", resp.Trailer)
	}
	code, a := do(t, ts, "POST", "/v1/synthesize", `{"text":"x","wait":true}`, nil)
	if code != 400 || !strings.Contains(a["error"].(string), "wait") {
		t.Fatalf("wait is not a synthesize field: %d %v", code, a)
	}
}
