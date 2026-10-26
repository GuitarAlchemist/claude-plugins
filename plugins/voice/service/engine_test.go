package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// TestMain doubles as a fake piper: started with FAKE_PIPER=1, the test binary reads JSON lines,
// writes a WAV of 100 samples per character of text to output_file, and prints its path, the
// way piper --json-input does. The text "die" makes it exit. With FAKE_MCP=1 it runs
// `piper-voice mcp` instead.
func TestMain(m *testing.M) {
	if os.Getenv("FAKE_PIPER") == "1" {
		fakePiper()
		os.Exit(0)
	}
	if os.Getenv("FAKE_MCP") == "1" {
		if err := mcpCmd(); err != nil {
			os.Exit(1)
		}
		os.Exit(0)
	}
	os.Exit(m.Run())
}

func fakePiper() {
	sc := bufio.NewScanner(os.Stdin)
	for sc.Scan() {
		var in struct {
			Text       string `json:"text"`
			OutputFile string `json:"output_file"`
		}
		if err := json.Unmarshal(sc.Bytes(), &in); err != nil || in.Text == "die" {
			os.Exit(3)
		}
		if in.Text == "hang" {
			_ = os.WriteFile(in.OutputFile+".started", nil, 0o600)
			_, _ = io.Copy(io.Discard, os.Stdin)
			_ = os.WriteFile(in.OutputFile+".eof", nil, 0o600)
			return
		}
		pcm := make([]byte, 200*len([]rune(in.Text)))
		if err := os.WriteFile(in.OutputFile, append(wavHeader(testRate, len(pcm)), pcm...), 0o644); err != nil {
			os.Exit(4)
		}
		fmt.Println(in.OutputFile)
	}
}

func TestPiperCancellationReleasesTheExistingProcess(t *testing.T) {
	e, err := startFake(t, testVoice, 1)
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	p := e.(*piperCLI)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { _, err := e.Synthesize(ctx, "hang"); done <- err }()
	deadline := time.After(time.Second)
	for {
		markers, _ := filepath.Glob(filepath.Join(p.tmp, "*.started"))
		if len(markers) != 0 {
			break
		}
		select {
		case <-deadline:
			t.Fatal("fake request did not start")
		case <-time.After(time.Millisecond):
		}
	}
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("got %v", err)
		}
	case <-time.After(time.Second):
		// Only a fake child is involved. Release it even on the red baseline.
		_ = p.cmd.Process.Kill()
		t.Fatal("Piper ignored cancellation")
	}
	if e.Alive() {
		t.Fatal("cancelled process remained reusable")
	}
}

func TestPiperRejectsInvalidRateBeforeStartingAProcess(t *testing.T) {
	for _, rate := range []int{-1, 0, 48001, 1000000000} {
		v := testVoice
		v.SampleRate = rate
		_, err := startPiper("must-not-be-executed", nil, v, 1, t.TempDir(), log.New(io.Discard, "", 0))
		if err == nil || !strings.Contains(err.Error(), "1 to 48000") {
			t.Fatalf("rate %d: %v", rate, err)
		}
	}
}

func TestPiperWaitingRequestCanCancelWithoutKillingAnotherRequest(t *testing.T) {
	e, err := startFake(t, testVoice, 1)
	if err != nil {
		t.Fatal(err)
	}
	p := e.(*piperCLI)
	defer e.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { _, err := e.Synthesize(ctx, "hang"); done <- err }()
	deadline := time.After(time.Second)
	for {
		markers, _ := filepath.Glob(filepath.Join(p.tmp, "*.started"))
		if len(markers) != 0 {
			break
		}
		select {
		case <-deadline:
			t.Fatal("fake request did not start")
		case <-time.After(time.Millisecond):
		}
	}
	waitCtx, waitCancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer waitCancel()
	waited := make(chan error, 1)
	go func() { _, err := e.Synthesize(waitCtx, "not admitted"); waited <- err }()
	select {
	case err := <-waited:
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("queued request ignored its deadline")
	}
	if !e.Alive() {
		t.Fatal("queued cancellation killed another request")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("active request did not stop")
	}
}

func TestPiperConcurrentCloseDoesNotWaitBehindBlockedSynthesis(t *testing.T) {
	e, err := startFake(t, testVoice, 1)
	if err != nil {
		t.Fatal(err)
	}
	p := e.(*piperCLI)
	defer e.Close()
	done := make(chan error, 1)
	go func() { _, err := e.Synthesize(context.Background(), "hang"); done <- err }()
	deadline := time.After(time.Second)
	for {
		markers, _ := filepath.Glob(filepath.Join(p.tmp, "*.started"))
		if len(markers) > 0 {
			break
		}
		select {
		case <-deadline:
			t.Fatal("fake request did not start")
		case <-time.After(time.Millisecond):
		}
	}
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); _ = e.Close() }()
	}
	closed := make(chan struct{})
	go func() { wg.Wait(); close(closed) }()
	select {
	case <-closed:
	case <-time.After(time.Second):
		_ = p.cmd.Process.Kill()
		markers, _ := filepath.Glob(filepath.Join(p.tmp, "*.eof"))
		// Diagnostic control: same fake binary, only its runtime exit sleep differs.
		t.Setenv("GORACE", os.Getenv("GORACE")+" atexit_sleep_ms=0")
		control, err := startFake(t, testVoice, 1)
		if err != nil {
			t.Fatal(err)
		}
		before := time.Now()
		_ = control.Close()
		t.Fatalf("Close waited on synthesis gate: fake already reached EOF=%t; control child Close without race exit sleep=%s", len(markers) > 0, time.Since(before))
	}
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("blocked synthesis did not return")
	}
	if e.Alive() {
		t.Fatal("closed engine reported alive")
	}
}

func startFake(t *testing.T, v Voice, lengthScale float64) (Engine, error) {
	t.Helper()
	return startPiper(os.Args[0], append(os.Environ(), "FAKE_PIPER=1"), v, lengthScale, t.TempDir(), log.New(io.Discard, "", 0))
}

func TestPiperCLIFramesEachSentence(t *testing.T) {
	e, err := startFake(t, testVoice, 1)
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	for _, s := range []string{"bonjour", "à demain"} {
		pcm, err := e.Synthesize(context.Background(), s)
		if err != nil {
			t.Fatal(err)
		}
		if want := 200 * len([]rune(s)); len(pcm) != want {
			t.Fatalf("%q: %d bytes, want %d", s, len(pcm), want)
		}
	}
	if !e.Alive() {
		t.Fatal("engine died")
	}
}

func TestPoolRestartsAStoppedEngine(t *testing.T) {
	started := 0
	pool := NewPool(2, func(v Voice, ls float64) (Engine, error) {
		started++
		return startFake(t, v, ls)
	})
	defer pool.Close()
	e, err := pool.Get(testVoice, 1)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.Synthesize(context.Background(), "die"); err == nil {
		t.Fatal("a dead piper gave no error")
	}
	if e.Alive() {
		t.Fatal("the engine still says it is alive")
	}
	e2, err := pool.Get(testVoice, 1)
	if err != nil || e2 == e || started != 2 {
		t.Fatalf("no restart: %v, started %d", err, started)
	}
	if _, err := e2.Synthesize(context.Background(), "encore"); err != nil {
		t.Fatal(err)
	}
	if again, _ := pool.Get(testVoice, 1); again != e2 || started != 2 {
		t.Fatal("a live engine was not reused")
	}
	other := testVoice
	other.ID = "other"
	pool.Get(other, 1)
	pool.Get(testVoice, 2)
	if len(pool.engines) > 2 || started != 4 {
		t.Fatalf("%d engines kept, %d started; the pool keeps at most 2", len(pool.engines), started)
	}
}
