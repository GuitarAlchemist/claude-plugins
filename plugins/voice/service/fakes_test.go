package main

import (
	"context"
	"errors"
	"io"
	"log"
	"slices"
	"sync"
	"testing"
	"time"
)

// recorder keeps what the fakes did, in order.
type recorder struct {
	mu     sync.Mutex
	events []string
}

func (r *recorder) add(e string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.events = append(r.events, e)
}

func (r *recorder) all() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return slices.Clone(r.events)
}

func (r *recorder) index(t *testing.T, e string) int {
	t.Helper()
	i := slices.Index(r.all(), e)
	if i < 0 {
		t.Fatalf("no %q in %q", e, r.all())
	}
	return i
}

// waitFor polls until e has been recorded.
func (r *recorder) waitFor(t *testing.T, e string) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for !slices.Contains(r.all(), e) {
		if time.Now().After(deadline) {
			t.Fatalf("no %q after 3 s: %q", e, r.all())
		}
		time.Sleep(5 * time.Millisecond)
	}
}

const testRate = 22050

type fakeEngine struct {
	rec   *recorder
	delay time.Duration
}

// Synthesize returns the sentence's own bytes as its "audio"; the sentence "boom." fails.
func (f *fakeEngine) Synthesize(_ context.Context, s string) ([]byte, error) {
	f.rec.add("synth " + s)
	if s == "boom." {
		return nil, errors.New("the engine broke")
	}
	time.Sleep(f.delay)
	f.rec.add("synthesized " + s)
	return []byte(s), nil
}
func (f *fakeEngine) SampleRate() int { return testRate }
func (f *fakeEngine) Alive() bool     { return true }
func (f *fakeEngine) Close() error    { return nil }

type fakePlayer struct {
	rec *recorder
	dur time.Duration
}

func (f *fakePlayer) SampleRate() int { return testRate }

func (f *fakePlayer) Play(ctx context.Context, pcm []byte) error {
	f.rec.add("play " + string(pcm))
	select {
	case <-time.After(f.dur):
		f.rec.add("played " + string(pcm))
		return nil
	case <-ctx.Done():
		f.rec.add("cut " + string(pcm))
		return ctx.Err()
	}
}

func testSpeaker(rec *recorder, synth, play time.Duration) *Speaker {
	eng := &fakeEngine{rec: rec, delay: synth}
	return NewSpeaker(func(Voice, float64) (Engine, error) { return eng, nil },
		&fakePlayer{rec: rec, dur: play}, nil, log.New(io.Discard, "", 0))
}

var testVoice = Voice{ID: "fr_FR-test-medium", Language: "fr_FR", Quality: "medium", SampleRate: testRate, License: "test"}
