package main

import (
	"context"
	"errors"
	"io"
	"log"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type blockedReviewPlayer struct{ started, release chan struct{} }

func (p *blockedReviewPlayer) SampleRate() int { return testRate }
func (p *blockedReviewPlayer) Play(context.Context, []byte) error {
	close(p.started)
	<-p.release
	return nil
}

type instantReviewEngine struct{}

func (instantReviewEngine) Synthesize(context.Context, string) ([]byte, error) {
	return []byte{1, 0}, nil
}
func (instantReviewEngine) SampleRate() int { return testRate }
func (instantReviewEngine) Alive() bool     { return true }
func (instantReviewEngine) Close() error    { return nil }
func TestReviewEndIsIdempotentAndAddAfterEndIsRefused(t *testing.T) {
	s := testSpeaker(&recorder{}, 0, 0)
	defer s.Stop()
	u, err := s.Begin(testVoice, 1, 1)
	if err != nil {
		t.Fatal(err)
	}
	u.End()
	defer func() {
		if v := recover(); v != nil {
			t.Fatalf("End/Add panicked: %v", v)
		}
	}()
	u.End()
	if u.Add("must be refused") {
		t.Fatal("accepted after End")
	}
}
func TestReviewStopWaitNeverAcknowledgesAnInFlightPlayer(t *testing.T) {
	p := &blockedReviewPlayer{make(chan struct{}), make(chan struct{})}
	s := NewSpeaker(func(Voice, float64) (Engine, error) { return instantReviewEngine{}, nil }, p, nil, log.New(io.Discard, "", 0))
	u, err := s.Begin(testVoice, 1, 1)
	if err != nil {
		t.Fatal(err)
	}
	u.Add("this is synthetic")
	u.End()
	select {
	case <-p.started:
	case <-time.After(time.Second):
		t.Fatal("player did not start")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	result, err := s.StopAndWait(ctx)
	if !errors.Is(err, context.DeadlineExceeded) || result.Acknowledged {
		t.Fatalf("%+v %v", result, err)
	}
	if result.Error == "" {
		t.Fatal("unacknowledged stop has no explicit reason")
	}
	rec := httptest.NewRecorder()
	(&Server{Speaker: s}).health(rec, httptest.NewRequest("GET", "http://127.0.0.1/health", nil))
	if rec.Code != 503 {
		t.Fatal("unavailable service advertised ready")
	}
	if _, err := s.Begin(testVoice, 1, 1); err == nil {
		t.Fatal("unacknowledged speaker accepted new work")
	}
	close(p.release)
}

func TestReviewExactAdmissionAndWaitingQueueLimits(t *testing.T) {
	s := &Speaker{queue: make(chan *Utterance, 32)}
	s.gen, s.stopGen = context.WithCancel(context.Background())
	for i := 0; i < 32; i++ {
		if _, err := s.Begin(testVoice, 1, 1); err != nil {
			t.Fatal(i, err)
		}
	}
	if _, err := s.Begin(testVoice, 1, 1); !errors.Is(err, errQueueFull) {
		t.Fatalf("33rd entry: %v", err)
	}
	r, err := s.StopAndWait(context.Background())
	if err != nil || !r.Acknowledged || r.Stopped != 32 {
		t.Fatal(r, err)
	}
	u, err := s.Begin(testVoice, 1, 64)
	if err != nil {
		t.Fatal(err)
	}
	if !u.Add(strings.Repeat("界", 20000)) || u.Add("x") || u.Add(string([]byte{0xff})) {
		t.Fatal("Unicode limit boundary is not enforced")
	}
	u.Stop()
	u.End()
	v, err := s.Begin(testVoice, 1, 64)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 64; i++ {
		if !v.Add("x") {
			t.Fatal("64-slot boundary", i)
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()
	if v.AddContext(ctx, "overflow") {
		t.Fatal("65th sentence admitted without capacity")
	}
	s.Stop()
}
func TestReviewSpeakerKeepsItsExistingPipelineAndAcknowledgesStop(t *testing.T) {
	rec := &recorder{}
	s := testSpeaker(rec, 0, time.Second)
	u, err := s.Begin(testVoice, 1, 2)
	if err != nil {
		t.Fatal(err)
	}
	u.Add("first.")
	u.Add("second.")
	u.End()
	rec.waitFor(t, "play first.")
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	result, err := s.StopAndWait(ctx)
	if err != nil || !result.Acknowledged || result.Generation == 0 {
		t.Fatalf("%+v %v", result, err)
	}
	for _, e := range rec.all() {
		if e == "play second." {
			t.Fatal(rec.all())
		}
	}
}
func TestReviewAdmissionHasNumericBoundsAndContext(t *testing.T) {
	s := testSpeaker(&recorder{}, 0, 0)
	defer s.Stop()
	if _, err := s.Begin(testVoice, 1, 65); err == nil {
		t.Fatal("unbounded sentence buffer accepted")
	}
	u, err := s.Begin(testVoice, 1, 1)
	if err != nil {
		t.Fatal(err)
	}
	if u.Add(strings.Repeat("é", 20001)) {
		t.Fatal("oversize text accepted")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if u.AddContext(ctx, "cancelled") {
		t.Fatal("cancelled admission accepted")
	}
	u.End()
}

func TestReviewStopAtQueueToRunnerBoundary(t *testing.T) {
	p := &blockedReviewPlayer{make(chan struct{}), make(chan struct{})}
	defer close(p.release)
	s := &Speaker{engines: func(Voice, float64) (Engine, error) { return instantReviewEngine{}, nil }, player: p, log: log.New(io.Discard, "", 0), queue: make(chan *Utterance, 32)}
	s.gen, s.stopGen = context.WithCancel(context.Background())
	u, err := s.Begin(testVoice, 1, 1)
	if err != nil {
		t.Fatal(err)
	}
	u.Add("synthetic")
	u.End()
	originalCancel := s.stopGen
	s.stopGen = func() {
		go s.run()
		// Force a runner to contend at the stop's publication boundary.
		select {
		case <-p.started:
		case <-time.After(30 * time.Millisecond):
		}
		originalCancel()
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	r, err := s.StopAndWait(ctx)
	if err != nil || !r.Acknowledged {
		t.Fatalf("%+v %v", r, err)
	}
	select {
	case <-u.Done():
	case <-ctx.Done():
		t.Fatal("cancelled runner did not finish")
	}
	select {
	case <-p.started:
		t.Fatal("old player ran across an acknowledged queue-to-runner stop")
	default:
	}
}
