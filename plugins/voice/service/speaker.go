package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"sync"
	"sync/atomic"
	"time"
)

// Player plays 16-bit mono PCM at SampleRate on the local output device.
type Player interface {
	SampleRate() int
	// Play returns once pcm has been played, or as soon as ctx is done.
	Play(ctx context.Context, pcm []byte) error
}

// Utterance is one request to speak: its sentences arrive through Add, all at once or as a
// stream, and End says there are no more.
type Utterance struct {
	ID    string
	Voice Voice
	Rate  float64

	in        chan string
	ctx       context.Context
	cancel    context.CancelFunc
	done      chan struct{}
	sentences atomic.Int64
	playedMs  atomic.Int64
	stopped   atomic.Bool

	errMu sync.Mutex
	err   error
}

// Add queues one sentence. It returns false once the utterance has been stopped.
func (u *Utterance) Add(sentence string) bool {
	select {
	case u.in <- sentence:
		u.sentences.Add(1)
		return true
	case <-u.ctx.Done():
		return false
	}
}

// End says no sentence will follow.
func (u *Utterance) End() { close(u.in) }

// Stop cuts this utterance alone, whether it is playing or still queued.
func (u *Utterance) Stop() { u.cancel() }

// Done is closed once the utterance has been played, stopped, or has failed.
func (u *Utterance) Done() <-chan struct{} { return u.done }

func (u *Utterance) Sentences() int  { return int(u.sentences.Load()) }
func (u *Utterance) PlayedMs() int64 { return u.playedMs.Load() }
func (u *Utterance) Stopped() bool   { return u.stopped.Load() }

func (u *Utterance) Err() error {
	u.errMu.Lock()
	defer u.errMu.Unlock()
	return u.err
}

func (u *Utterance) fail(err error) {
	u.errMu.Lock()
	defer u.errMu.Unlock()
	if u.err == nil {
		u.err = err
	}
}

var errQueueFull = errors.New("too many utterances are waiting; try again, or stop them first")

// Speaker plays utterances one after another. Within one, sentence n+1 is synthesized while
// sentence n plays. Stop cuts the current one and drops every utterance queued before it.
type Speaker struct {
	engines func(v Voice, rate float64) (Engine, error)
	player  Player
	log     *log.Logger
	queue   chan *Utterance
	seq     atomic.Uint64
	current atomic.Pointer[Utterance]

	mu      sync.Mutex
	gen     context.Context
	stopGen context.CancelFunc
}

func NewSpeaker(engines func(v Voice, rate float64) (Engine, error), player Player, logger *log.Logger) *Speaker {
	s := &Speaker{engines: engines, player: player, log: logger, queue: make(chan *Utterance, 32)}
	s.gen, s.stopGen = context.WithCancel(context.Background())
	go s.run()
	return s
}

// Begin queues a new utterance; room is how many sentences Add can take before the speaker
// reads them.
func (s *Speaker) Begin(v Voice, rate float64, room int) (*Utterance, error) {
	s.mu.Lock()
	ctx, cancel := context.WithCancel(s.gen)
	s.mu.Unlock()
	u := &Utterance{ID: fmt.Sprintf("u%d", s.seq.Add(1)), Voice: v, Rate: rate,
		in: make(chan string, room), ctx: ctx, cancel: cancel, done: make(chan struct{})}
	select {
	case s.queue <- u:
		return u, nil
	default:
		cancel()
		return nil, errQueueFull
	}
}

// Stop cuts what is playing and drops what is queued. It returns how many utterances it cut.
func (s *Speaker) Stop() int {
	s.mu.Lock()
	s.stopGen()
	s.gen, s.stopGen = context.WithCancel(context.Background())
	s.mu.Unlock()
	n := len(s.queue)
	if s.current.Load() != nil {
		n++
	}
	return n
}

func (s *Speaker) run() {
	for u := range s.queue {
		s.current.Store(u)
		s.speak(u)
		s.current.Store(nil)
		u.stopped.Store(u.ctx.Err() != nil && u.Err() == nil)
		u.cancel()
		close(u.done)
	}
}

func (s *Speaker) speak(u *Utterance) {
	if u.ctx.Err() != nil {
		return
	}
	pcms := make(chan []byte, 1)
	go func() {
		defer close(pcms)
		eng, err := s.engines(u.Voice, u.Rate)
		if err != nil {
			u.fail(err)
			s.log.Printf("%s: %v", u.ID, err)
			return
		}
		if eng.SampleRate() != s.player.SampleRate() {
			u.fail(fmt.Errorf("voice %s is at %d Hz; this service plays %d Hz", u.Voice.ID, eng.SampleRate(), s.player.SampleRate()))
			return
		}
		for i := 1; ; i++ {
			var text string
			var ok bool
			select {
			case <-u.ctx.Done():
				return
			case text, ok = <-u.in:
			}
			if !ok {
				return
			}
			t := time.Now()
			pcm, err := eng.Synthesize(u.ctx, text)
			if err != nil {
				u.fail(err)
				s.log.Printf("%s: sentence %d: %v", u.ID, i, err)
				return
			}
			s.log.Printf("%s: sentence %d synthesized in %d ms (%d ms of audio)", u.ID, i, time.Since(t).Milliseconds(), audioMs(pcm, eng.SampleRate()))
			select {
			case pcms <- pcm:
			case <-u.ctx.Done():
				return
			}
		}
	}()
	i := 0
	for pcm := range pcms {
		i++
		if u.ctx.Err() != nil {
			continue
		}
		s.log.Printf("%s: sentence %d playing", u.ID, i)
		t := time.Now()
		err := s.player.Play(u.ctx, pcm)
		u.playedMs.Add(time.Since(t).Milliseconds())
		switch {
		case u.ctx.Err() != nil:
			s.log.Printf("%s: sentence %d stopped", u.ID, i)
		case err != nil:
			u.fail(err)
			s.log.Printf("%s: sentence %d: %v", u.ID, i, err)
			u.cancel()
		default:
			s.log.Printf("%s: sentence %d played", u.ID, i)
		}
	}
}
