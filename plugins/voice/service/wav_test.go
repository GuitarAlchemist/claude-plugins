package main

import (
	"bytes"
	"testing"
)

func TestWAVRoundTrip(t *testing.T) {
	pcm := []byte{1, 0, 2, 0, 3, 0}
	got, rate, err := parseWAV(append(wavHeader(22050, len(pcm)), pcm...))
	if err != nil || rate != 22050 || !bytes.Equal(got, pcm) {
		t.Fatalf("got %v %d %v", got, rate, err)
	}
	if ms := audioMs(make([]byte, 44100), 22050); ms != 1000 {
		t.Fatalf("audioMs = %d", ms)
	}
}

func TestWAVRefusesOtherFormats(t *testing.T) {
	stereo := wavHeader(22050, 0)
	stereo[22] = 2
	for name, b := range map[string][]byte{"empty": nil, "not riff": []byte("RIFX....WAVE"), "stereo": stereo,
		"no data": wavHeader(22050, 0)[:36]} {
		if _, _, err := parseWAV(b); err == nil {
			t.Errorf("%s: no error", name)
		}
	}
}
