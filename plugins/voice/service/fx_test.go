package main

import (
	"bytes"
	"encoding/binary"
	"io"
	"log"
	"math"
	"slices"
	"sync/atomic"
	"testing"
	"time"
)

func pcmOf(samples []float64) []byte {
	b := make([]byte, 2*len(samples))
	for i, x := range samples {
		binary.LittleEndian.PutUint16(b[2*i:], uint16(int16(math.Round(x*32767))))
	}
	return b
}

func samplesOf(pcm []byte) []float64 {
	s := make([]float64, len(pcm)/2)
	for i := range s {
		s[i] = float64(int16(binary.LittleEndian.Uint16(pcm[2*i:]))) / 32768
	}
	return s
}

func tone(hz, amp float64, n int) []float64 {
	s := make([]float64, n)
	for i := range s {
		s[i] = amp * math.Sin(2*math.Pi*hz*float64(i)/testRate)
	}
	return s
}

func rms(s []float64) float64 {
	var sum float64
	for _, x := range s {
		sum += x * x
	}
	return math.Sqrt(sum / float64(len(s)))
}

func TestEffectNames(t *testing.T) {
	for _, name := range []string{"", "none"} {
		if fx, err := effects(name, testRate); fx != nil || err != nil {
			t.Fatalf("effects(%q) = %v, %v; want no effect", name, fx != nil, err)
		}
	}
	if fx, err := effects("warm", testRate); fx == nil || err != nil {
		t.Fatalf("effects(warm) = %v, %v", fx != nil, err)
	}
	if _, err := effects("loud", testRate); err == nil {
		t.Fatal("an unknown preset was accepted")
	}
}

func TestWarmKeepsSilenceSilentAndTheLength(t *testing.T) {
	w := newWarm(testRate)
	in := make([]byte, 2*testRate)
	out := w.Process(in)
	if !bytes.Equal(in, out) {
		t.Fatal("silence came out as sound")
	}
	if !bytes.Equal(w.Tail(), make([]byte, len(w.Tail()))) {
		t.Fatal("a silent input left a tail that is not silent")
	}
	odd := w.Process([]byte{1, 2, 3})
	if len(odd) != 3 || odd[2] != 3 {
		t.Fatalf("an odd last byte did not pass through: %v", odd)
	}
}

// The effect keeps its state between calls, so an utterance played sentence by sentence sounds
// the same as if it were one piece.
func TestWarmSoundsTheSameInPiecesAsWhole(t *testing.T) {
	sig := tone(220, 0.3, testRate/2)
	for i := range sig {
		sig[i] += 0.2 * math.Sin(2*math.Pi*3100*float64(i)/testRate)
	}
	pcm := pcmOf(sig)
	whole := newWarm(testRate).Process(pcm)
	w := newWarm(testRate)
	var pieces []byte
	for _, cut := range [][2]int{{0, 1000}, {1000, 7002}, {7002, len(pcm)}} {
		pieces = append(pieces, w.Process(pcm[cut[0]:cut[1]])...)
	}
	if !bytes.Equal(whole, pieces) {
		t.Fatal("processing in pieces changed the sound")
	}
}

// Quiet tones, under the compressor's threshold: the lows come out louder than the mids, and
// the mids louder than the highs.
func TestWarmIsWarm(t *testing.T) {
	gain := func(hz float64) float64 {
		in := tone(hz, 0.02, testRate/2)
		out := samplesOf(newWarm(testRate).Process(pcmOf(in)))
		skip := testRate / 10 // past the filters' settling
		return 20 * math.Log10(rms(out[skip:])/rms(in[skip:]))
	}
	low, mid, high := gain(150), gain(1000), gain(10000)
	if !(low > mid+1 && mid > high+1) {
		t.Fatalf("gains 150 Hz %.2f dB, 1 kHz %.2f dB, 10 kHz %.2f dB: not warm", low, mid, high)
	}
}

// A full-scale input is clipped, never wrapped round from +32767 to -32768.
func TestWarmClipsInsteadOfWrapping(t *testing.T) {
	sq := make([]float64, testRate/4)
	for i := range sq {
		sq[i] = 0.999
		if i/200%2 == 1 {
			sq[i] = -0.999
		}
	}
	out := samplesOf(newWarm(testRate).Process(pcmOf(sq)))
	for i := 1; i < len(out); i++ {
		if math.Abs(out[i]-out[i-1]) > 1.5 {
			t.Fatalf("sample %d jumps from %.3f to %.3f: it wrapped", i, out[i-1], out[i])
		}
	}
}

func TestWarmRingsAfterTheInputEnds(t *testing.T) {
	w := newWarm(testRate)
	click := make([]float64, 200)
	click[0] = 0.8
	w.Process(pcmOf(click))
	if rms(samplesOf(w.Tail())) == 0 {
		t.Fatal("no reverberation after a click")
	}
}

// fakeEffect marks what it processed. It changes the length, which a real effect never does,
// so the test can see it.
type fakeEffect struct{}

func (fakeEffect) Process(p []byte) []byte { return []byte("fx(" + string(p) + ")") }
func (fakeEffect) Tail() []byte            { return []byte("tail") }

func fxSpeaker(rec *recorder, play time.Duration, made *atomic.Int64) *Speaker {
	eng := &fakeEngine{rec: rec}
	return NewSpeaker(func(Voice, float64) (Engine, error) { return eng, nil }, &fakePlayer{rec: rec, dur: play},
		func() Effect { made.Add(1); return fakeEffect{} }, log.New(io.Discard, "", 0))
}

func TestEachSentenceIsPlayedThroughTheEffectThenItsTail(t *testing.T) {
	rec, made := &recorder{}, &atomic.Int64{}
	s := fxSpeaker(rec, 10*time.Millisecond, made)
	<-speakAll(t, s, "a", "b").Done()
	<-speakAll(t, s, "c").Done()
	var plays []string
	for _, e := range rec.all() {
		if len(e) > 5 && e[:5] == "play " {
			plays = append(plays, e[5:])
		}
	}
	if want := []string{"fx(a)", "fx(b)", "tail", "fx(c)", "tail"}; !slices.Equal(plays, want) {
		t.Fatalf("played %q, want %q", plays, want)
	}
	if made.Load() != 2 {
		t.Fatalf("%d effects made for 2 utterances", made.Load())
	}
}

func TestAStoppedUtteranceHasNoTail(t *testing.T) {
	rec, made := &recorder{}, &atomic.Int64{}
	s := fxSpeaker(rec, 5*time.Second, made)
	u := speakAll(t, s, "a")
	rec.waitFor(t, "play fx(a)")
	s.Stop()
	<-u.Done()
	if slices.Contains(rec.all(), "play tail") {
		t.Fatalf("a stopped utterance played its tail: %q", rec.all())
	}
}
