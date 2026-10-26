package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf8"
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
	inputMu   sync.Mutex
	changed   chan struct{}
	ended     bool
	runes     int
	doneOnce  sync.Once

	errMu sync.Mutex
	err   error
}

// Add queues one sentence. It returns false once the utterance has been stopped.
func (u *Utterance) Add(sentence string) bool {
	return u.AddContext(context.Background(), sentence)
}

// AddContext atomically accepts one sentence or refuses it. Cancellation of a
// blocked admission does not cancel sentences already accepted by this turn.
func (u *Utterance) AddContext(ctx context.Context, sentence string) bool {
	if !utf8.ValidString(sentence) {
		return false
	}
	n := utf8.RuneCountInString(sentence)
	for {
		u.inputMu.Lock()
		if u.ended || u.ctx.Err() != nil || ctx.Err() != nil || u.runes+n > 20000 {
			u.inputMu.Unlock()
			return false
		}
		select {
		case u.in <- sentence:
			u.runes += n
			u.sentences.Add(1)
			u.signalInput()
			u.inputMu.Unlock()
			return true
		default:
		}
		changed := u.changed
		u.inputMu.Unlock()
		select {
		case <-ctx.Done():
			return false
		case <-u.ctx.Done():
			return false
		case <-changed:
		}
	}
}
func (u *Utterance) signalInput() { close(u.changed); u.changed = make(chan struct{}) }
func (u *Utterance) next() (string, bool) {
	for {
		u.inputMu.Lock()
		if u.ctx.Err() != nil {
			u.inputMu.Unlock()
			return "", false
		}
		select {
		case text := <-u.in:
			u.signalInput()
			u.inputMu.Unlock()
			return text, true
		default:
		}
		if u.ended {
			u.inputMu.Unlock()
			return "", false
		}
		changed := u.changed
		u.inputMu.Unlock()
		select {
		case <-u.ctx.Done():
			return "", false
		case <-changed:
		}
	}
}

// End says no sentence will follow.
func (u *Utterance) End() {
	u.inputMu.Lock()
	defer u.inputMu.Unlock()
	if !u.ended {
		u.ended = true
		u.signalInput()
	}
}

// Stop cuts this utterance alone, whether it is playing or still queued.
func (u *Utterance) Stop()     { u.inputMu.Lock(); defer u.inputMu.Unlock(); u.cancel(); u.signalInput() }
func (u *Utterance) complete() { u.doneOnce.Do(func() { close(u.done) }) }

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
	fx      func() Effect // nil: play the voice as Piper made it
	log     *log.Logger
	queue   chan *Utterance
	seq     atomic.Uint64
	current atomic.Pointer[Utterance]

	mu          sync.Mutex
	gen         context.Context
	stopGen     context.CancelFunc
	generation  uint64
	unavailable error
	stopping    int
}

// fx, when not nil, makes the effect each utterance is played through.
func NewSpeaker(engines func(v Voice, rate float64) (Engine, error), player Player, fx func() Effect, logger *log.Logger) *Speaker {
	s := &Speaker{engines: engines, player: player, fx: fx, log: logger, queue: make(chan *Utterance, 32)}
	s.gen, s.stopGen = context.WithCancel(context.Background())
	go s.run()
	return s
}

// Begin queues a new utterance; room is how many sentences Add can take before the speaker
// reads them.
func (s *Speaker) Begin(v Voice, rate float64, room int) (*Utterance, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.unavailable != nil {
		return nil, s.unavailable
	}
	if s.stopping > 0 {
		return nil, errors.New("voice stop is still awaiting acknowledgement")
	}
	if room < 0 || room > 64 {
		return nil, errors.New("sentence queue must contain 0 to 64 entries")
	}
	if room == 0 {
		room = 1
	} // existing streaming callers use zero; one bounded slot avoids rendezvous races
	if v.SampleRate < 1 || v.SampleRate > 48000 {
		return nil, errors.New("voice rate must be 1 to 48000 Hz")
	}
	ctx, cancel := context.WithCancel(s.gen)
	u := &Utterance{ID: fmt.Sprintf("u%d", s.seq.Add(1)), Voice: v, Rate: rate,
		in: make(chan string, room), ctx: ctx, cancel: cancel, done: make(chan struct{}), changed: make(chan struct{})}
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
	defer s.mu.Unlock()
	r, _ := s.stopLocked()
	return r.Stopped
}

type StopResult struct {
	Stopped      int    `json:"stopped"`
	Acknowledged bool   `json:"acknowledged"`
	Generation   uint64 `json:"generation"`
	Error        string `json:"error,omitempty"`
}

func (s *Speaker) stopLocked() (StopResult, *Utterance) {
	current := s.current.Load()
	s.stopGen()
	s.gen, s.stopGen = context.WithCancel(context.Background())
	s.generation++
	r := StopResult{Generation: s.generation}
	if current != nil {
		r.Stopped++
		current.Stop()
	}
	for {
		select {
		case u := <-s.queue:
			u.Stop()
			u.stopped.Store(true)
			u.complete()
			r.Stopped++
		default:
			return r, current
		}
	}
}

// StopAndWait acknowledges only service-side purge: the old player and provider
// must have returned. Already played hardware samples cannot be recalled.
func (s *Speaker) StopAndWait(ctx context.Context) (StopResult, error) {
	s.mu.Lock()
	s.stopping++
	r, current := s.stopLocked()
	s.mu.Unlock()
	defer func() { s.mu.Lock(); s.stopping--; s.mu.Unlock() }()
	ctx, cancel := context.WithTimeout(ctx, 250*time.Millisecond)
	defer cancel()
	if current != nil {
		select {
		case <-current.Done():
		case <-ctx.Done():
			s.mu.Lock()
			s.unavailable = errors.New("voice stop was not acknowledged; restart the service")
			r.Error = s.unavailable.Error()
			s.mu.Unlock()
			return r, ctx.Err()
		}
	}
	r.Acknowledged = true
	return r, nil
}

func (s *Speaker) readinessError() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.unavailable
}

func (s *Speaker) run() {
	for u := range s.queue {
		s.mu.Lock()
		if u.ctx.Err() != nil {
			s.mu.Unlock()
			u.stopped.Store(true)
			u.complete()
			continue
		}
		s.current.Store(u)
		s.mu.Unlock()
		s.speak(u)
		s.mu.Lock()
		s.current.Store(nil)
		s.mu.Unlock()
		u.stopped.Store(u.ctx.Err() != nil && u.Err() == nil)
		u.cancel()
		u.complete()
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
		var fx Effect
		if s.fx != nil {
			fx = s.fx()
		}
		for i := 1; ; i++ {
			text, ok := u.next()
			if !ok {
				if fx != nil {
					select {
					case pcms <- fx.Tail():
					case <-u.ctx.Done():
					}
				}
				return
			}
			t := time.Now()
			pcm, err := eng.Synthesize(u.ctx, text)
			if err != nil {
				u.fail(err)
				s.log.Printf("%s: sentence %d: %v", u.ID, i, err)
				return
			}
			if len(pcm) > eng.SampleRate()*2*30 {
				u.fail(errors.New("sentence exceeds 30 seconds of PCM"))
				return
			}
			s.log.Printf("%s: sentence %d synthesized in %d ms (%d ms of audio)", u.ID, i, time.Since(t).Milliseconds(), audioMs(pcm, eng.SampleRate()))
			if fx != nil {
				pcm = fx.Process(pcm)
			}
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
