package main

import (
	"testing"
	"time"
)

func speakAll(t *testing.T, s *Speaker, sentences ...string) *Utterance {
	t.Helper()
	u, err := s.Begin(testVoice, 1, len(sentences))
	if err != nil {
		t.Fatal(err)
	}
	for _, x := range sentences {
		u.Add(x)
	}
	u.End()
	return u
}

func TestTheNextSentenceIsSynthesizedWhileOnePlays(t *testing.T) {
	rec := &recorder{}
	u := speakAll(t, testSpeaker(rec, 10*time.Millisecond, 150*time.Millisecond), "a", "b")
	<-u.Done()
	if rec.index(t, "synthesized b") > rec.index(t, "played a") {
		t.Fatalf("b was synthesized after a finished playing: %q", rec.all())
	}
	if rec.index(t, "play b") < rec.index(t, "played a") {
		t.Fatalf("b started before a ended: %q", rec.all())
	}
	if u.Sentences() != 2 || u.Stopped() || u.Err() != nil || u.PlayedMs() < 300 {
		t.Fatalf("sentences %d, stopped %v, err %v, played %d ms", u.Sentences(), u.Stopped(), u.Err(), u.PlayedMs())
	}
}

func TestStopCutsThePlayingSentenceAndDropsTheQueue(t *testing.T) {
	rec := &recorder{}
	s := testSpeaker(rec, 0, 5*time.Second)
	first := speakAll(t, s, "a", "b")
	queued := speakAll(t, s, "c")
	open, err := s.Begin(testVoice, 1, 0) // a stream still being written
	if err != nil {
		t.Fatal(err)
	}
	rec.waitFor(t, "play a")
	if n := s.Stop(); n != 3 {
		t.Fatalf("Stop() = %d, want 3", n)
	}
	if open.Add("late") {
		t.Fatal("a stopped stream took a sentence")
	}
	open.End()
	for _, u := range []*Utterance{first, queued, open} {
		select {
		case <-u.Done():
		case <-time.After(time.Second):
			t.Fatalf("%s still running a second after stop", u.ID)
		}
		if !u.Stopped() {
			t.Fatalf("%s is not marked stopped", u.ID)
		}
	}
	rec.index(t, "cut a")
	for _, e := range rec.all() {
		if e == "play b" || e == "play c" {
			t.Fatalf("%q after stop: %q", e, rec.all())
		}
	}
	after := speakAll(t, s, "d")
	rec.waitFor(t, "play d")
	s.Stop()
	<-after.Done()
}

func TestTheQueueHasALimit(t *testing.T) {
	s := testSpeaker(&recorder{}, 0, 5*time.Second)
	defer s.Stop()
	var err error
	for i := 0; i < 40 && err == nil; i++ {
		_, err = s.Begin(testVoice, 1, 1)
	}
	if err != errQueueFull {
		t.Fatalf("got %v, want errQueueFull", err)
	}
}
