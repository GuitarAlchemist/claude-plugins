package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"testing"
)

// TestMain doubles as a fake piper: started with FAKE_PIPER=1, the test binary reads JSON lines,
// writes a WAV of 100 samples per character of text to output_file, and prints its path, the
// way piper --json-input does. The text "die" makes it exit.
func TestMain(m *testing.M) {
	if os.Getenv("FAKE_PIPER") == "1" {
		fakePiper()
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
		pcm := make([]byte, 200*len([]rune(in.Text)))
		if err := os.WriteFile(in.OutputFile, append(wavHeader(testRate, len(pcm)), pcm...), 0o644); err != nil {
			os.Exit(4)
		}
		fmt.Println(in.OutputFile)
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
