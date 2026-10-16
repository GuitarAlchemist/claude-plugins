package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func testServer(t *testing.T, play time.Duration) (*httptest.Server, *recorder) {
	t.Helper()
	rec := &recorder{}
	s := &Server{Speaker: testSpeaker(rec, 0, play), Voices: []Voice{testVoice}, DefaultVoice: testVoice.ID,
		Engine: "fake", SampleRate: testRate, MaxText: 50}
	ts := httptest.NewServer(s.Handler())
	t.Cleanup(func() { s.Speaker.Stop(); ts.Close() })
	return ts, rec
}

func do(t *testing.T, ts *httptest.Server, method, path, body string, edit func(*http.Request)) (int, map[string]any) {
	t.Helper()
	req, err := http.NewRequest(method, ts.URL+path, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	if edit != nil {
		edit(req)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out map[string]any
	if strings.HasPrefix(path, "/v1/voices") {
		return resp.StatusCode, nil
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatalf("%s %s: answer is not JSON: %v", method, path, err)
	}
	return resp.StatusCode, out
}

func TestHealthAndVoices(t *testing.T) {
	ts, _ := testServer(t, 0)
	code, h := do(t, ts, "GET", "/health", "", nil)
	if code != 200 || h["ok"] != true || h["voice"] != testVoice.ID || h["sample_rate"] != float64(testRate) || h["version"] != version {
		t.Fatalf("health: %d %v", code, h)
	}
	resp, err := http.Get(ts.URL + "/v1/voices")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var vs []map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&vs); err != nil || len(vs) != 1 || vs[0]["id"] != testVoice.ID || vs[0]["license"] != "test" {
		t.Fatalf("voices: %v %v", vs, err)
	}
	if _, ok := vs[0]["Model"]; ok {
		t.Fatal("the model path leaks into /v1/voices")
	}
}

func TestSayQueuesAndWaitAnswersOncePlayed(t *testing.T) {
	ts, rec := testServer(t, 20*time.Millisecond)
	code, a := do(t, ts, "POST", "/v1/say", `{"text":"Un. Deux."}`, nil)
	if code != 200 || a["sentences"] != float64(2) || a["id"] == "" || a["played_ms"] != nil {
		t.Fatalf("say: %d %v", code, a)
	}
	code, a = do(t, ts, "POST", "/v1/say", `{"text":"Trois.","wait":true,"rate":1.5}`, nil)
	if code != 200 || a["sentences"] != float64(1) || a["stopped"] != false || a["played_ms"].(float64) < 20 {
		t.Fatalf("say wait: %d %v", code, a)
	}
	if rec.index(t, "played Trois.") < rec.index(t, "played Deux.") {
		t.Fatalf("utterances out of order: %q", rec.all())
	}
}

func TestSayRefusesBadRequests(t *testing.T) {
	ts, _ := testServer(t, 0)
	cases := map[string]struct {
		body string
		code int
		has  string
	}{
		"not json":      {`{`, 400, "not a say request"},
		"unknown field": {`{"text":"x","volume":3}`, 400, "volume"},
		"empty":         {`{"text":"  "}`, 400, "empty"},
		"only markup":   {`{"text":"*** ##"}`, 400, "nothing to say"},
		"too long":      {`{"text":"` + strings.Repeat("é", 51) + `"}`, 413, "51 characters"},
		"voice":         {`{"text":"x","voice":"nope"}`, 400, testVoice.ID},
		"rate":          {`{"text":"x","rate":3}`, 400, "rate"},
	}
	for name, c := range cases {
		code, a := do(t, ts, "POST", "/v1/say", c.body, nil)
		if msg, _ := a["error"].(string); code != c.code || !strings.Contains(msg, c.has) {
			t.Errorf("%s: %d %v, want %d with %q", name, code, a, c.code, c.has)
		}
	}
}

func TestStopCutsWhatIsPlaying(t *testing.T) {
	ts, rec := testServer(t, 5*time.Second)
	do(t, ts, "POST", "/v1/say", `{"text":"Long."}`, nil)
	rec.waitFor(t, "play Long.")
	code, a := do(t, ts, "POST", "/v1/stop", "", nil)
	if code != 200 || a["stopped"] != float64(1) {
		t.Fatalf("stop: %d %v", code, a)
	}
	rec.waitFor(t, "cut Long.")
}

func TestWebPagesAndForeignHostsAreRefused(t *testing.T) {
	ts, rec := testServer(t, 0)
	for name, edit := range map[string]func(*http.Request){
		"origin":       func(r *http.Request) { r.Header.Set("Origin", "https://example.com") },
		"rebound host": func(r *http.Request) { r.Host = "attacker.example:59126" },
	} {
		if code, a := do(t, ts, "POST", "/v1/say", `{"text":"x"}`, edit); code != 403 || a["error"] == nil {
			t.Errorf("%s: %d %v", name, code, a)
		}
	}
	if code, _ := do(t, ts, "GET", "/health", "", func(r *http.Request) { r.Host = "localhost:59126" }); code != 200 {
		t.Errorf("localhost refused: %d", code)
	}
	if len(rec.all()) != 0 {
		t.Fatalf("a refused request was spoken: %q", rec.all())
	}
}

func TestListenAddressIsLoopbackOnly(t *testing.T) {
	for addr, ok := range map[string]bool{"127.0.0.1:59126": true, "localhost:1": true, "[::1]:2": true,
		"0.0.0.0:59126": false, ":59126": false, "192.168.1.5:59126": false} {
		if err := loopbackOnly(addr); (err == nil) != ok {
			t.Errorf("loopbackOnly(%q) = %v", addr, err)
		}
	}
}
