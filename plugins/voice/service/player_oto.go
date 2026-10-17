//go:build !nooto

package main

import (
	"bytes"
	"context"
	"time"

	"github.com/ebitengine/oto/v3"
)

// otoPlayer plays through the default output device. Oto allows one context per process, so
// the sample rate is fixed when the service starts.
type otoPlayer struct {
	ctx  *oto.Context
	rate int
}

func newPlayer(rate int) (Player, error) {
	c, ready, err := oto.NewContext(&oto.NewContextOptions{SampleRate: rate, ChannelCount: 1, Format: oto.FormatSignedInt16LE})
	if err != nil {
		return nil, err
	}
	<-ready
	return &otoPlayer{ctx: c, rate: rate}, nil
}

func (o *otoPlayer) SampleRate() int { return o.rate }

func (o *otoPlayer) Play(ctx context.Context, pcm []byte) error {
	p := o.ctx.NewPlayer(bytes.NewReader(pcm))
	defer p.Close()
	p.Play()
	tick := time.NewTicker(10 * time.Millisecond)
	defer tick.Stop()
	for p.IsPlaying() {
		select {
		case <-ctx.Done():
			p.Pause()
			return ctx.Err()
		case <-tick.C:
		}
	}
	return nil
}
