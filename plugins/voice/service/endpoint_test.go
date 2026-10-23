package main

import (
	"encoding/binary"
	"math"
	"testing"
	"time"
)

// sine is d of a 440 Hz tone at amp (0..1) in 16-bit mono PCM at rate.
func sine(rate int, d time.Duration, amp float64) []byte {
	n := int(d.Seconds() * float64(rate))
	out := make([]byte, 2*n)
	for i := 0; i < n; i++ {
		s := amp * math.Sin(2*math.Pi*440*float64(i)/float64(rate))
		binary.LittleEndian.PutUint16(out[2*i:], uint16(int16(s*32767)))
	}
	return out
}

func silence(rate int, d time.Duration) []byte { return make([]byte, 2*int(d.Seconds()*float64(rate))) }

func TestEndpointerCutsSpeechBetweenSilences(t *testing.T) {
	e := NewEndpointer(sttRate)
	var cuts []Cut
	feed := func(pcm []byte) {
		for len(pcm) > 0 { // in the 64 ms pieces a browser sends
			n := min(2048, len(pcm))
			cuts = append(cuts, e.Feed(pcm[:n])...)
			pcm = pcm[n:]
		}
	}
	feed(silence(sttRate, time.Second))
	if len(cuts) != 0 {
		t.Fatalf("silence opened an utterance: %v", cuts)
	}
	feed(sine(sttRate, 500*time.Millisecond, 0.3))
	if len(cuts) != 1 || !cuts[0].Start {
		t.Fatalf("speech did not open one utterance: %d cuts", len(cuts))
	}
	feed(silence(sttRate, 500*time.Millisecond))
	if len(cuts) != 1 {
		t.Fatalf("500 ms of silence closed the utterance early")
	}
	feed(silence(sttRate, 400*time.Millisecond))
	if len(cuts) != 2 || cuts[1].Start {
		t.Fatalf("900 ms of silence did not close the utterance: %d cuts", len(cuts))
	}
	// 200 ms lead + 500 ms speech + 300 ms of kept tail, give or take a window
	if ms := audioMs(cuts[1].PCM, sttRate); ms < 940 || ms > 1060 {
		t.Fatalf("the utterance is %d ms long; want about 1000", ms)
	}
	if e.Started {
		t.Fatal("still open")
	}

	// a blip shorter than MinSpeech is dropped
	cuts = nil
	feed(sine(sttRate, 100*time.Millisecond, 0.3))
	feed(silence(sttRate, time.Second))
	if len(cuts) != 1 || !cuts[0].Start {
		t.Fatalf("a 100 ms blip: %v", cuts)
	}

	// flush closes what is open
	cuts = nil
	feed(sine(sttRate, 400*time.Millisecond, 0.3))
	if c, ok := e.Flush(); !ok || audioMs(c.PCM, sttRate) < 400 {
		t.Fatalf("flush: %v %v", ok, audioMs(c.PCM, sttRate))
	}
	if _, ok := e.Flush(); ok {
		t.Fatal("a second flush had something")
	}

	// a long utterance is cut at MaxLen
	e.MaxLen = 2 * time.Second
	cuts = nil
	feed(sine(sttRate, 3*time.Second, 0.3))
	if len(cuts) < 2 || cuts[0].Start != true || cuts[1].Start {
		t.Fatalf("3 s of speech with MaxLen 2 s: %d cuts", len(cuts))
	}
	if ms := audioMs(cuts[1].PCM, sttRate); ms < 1900 || ms > 2100 {
		t.Fatalf("cut at %d ms; want about 2000", ms)
	}
}

func TestResamplerKeepsLengthAndToneAcrossPieces(t *testing.T) {
	in := sine(44100, time.Second, 0.5)
	r := &Resampler{From: 44100, To: sttRate}
	var out []byte
	for p := 0; p < len(in); p += 1000 { // odd piece size: sample boundaries move every call
		out = append(out, r.Feed(in[p:min(p+1000, len(in))])...)
	}
	if n := len(out) / 2; n < sttRate-2 || n > sttRate+2 {
		t.Fatalf("1 s at 44100 became %d samples at 16000", n)
	}
	// the tone survives: the same RMS, and no seam louder than the tone itself
	if got, want := pcmRMS(out), pcmRMS(in); math.Abs(got-want) > 0.01 {
		t.Fatalf("rms %.3f, want %.3f", got, want)
	}
	for i := 2; i < len(out); i += 2 {
		a := int16(binary.LittleEndian.Uint16(out[i-2:]))
		b := int16(binary.LittleEndian.Uint16(out[i:]))
		if d := math.Abs(float64(b) - float64(a)); d > 0.5*32767*0.2 { // a 440 Hz tone at 16 kHz moves < 17 % of its amplitude per sample
			t.Fatalf("seam at sample %d: %d -> %d", i/2, a, b)
		}
	}
	if same := (&Resampler{From: 22050, To: 22050}).Feed(in[:100]); len(same) != 100 {
		t.Fatal("equal rates must pass the audio through")
	}
}

func TestCleanTranscriptDropsSoundTags(t *testing.T) {
	got := cleanTranscript("\n [BLANK_AUDIO]\n Bonjour tout le monde.\n(music)\n Ça va ?\n")
	if got != "Bonjour tout le monde. Ça va ?" {
		t.Fatalf("%q", got)
	}
}
