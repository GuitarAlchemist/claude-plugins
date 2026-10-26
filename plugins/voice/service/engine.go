package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// Engine turns one sentence into 16-bit mono PCM at SampleRate.
type Engine interface {
	Synthesize(ctx context.Context, sentence string) ([]byte, error)
	SampleRate() int
	Alive() bool
	Close() error
}

// piperCLI keeps one piper process warm. With --json-input, piper reads one JSON object per
// line and, once it has written that line's output_file, prints the file's path on stdout:
// that line marks where one sentence's audio ends.
type piperCLI struct {
	gate     chan struct{}
	cmd      *exec.Cmd
	stdin    io.WriteCloser
	out      *bufio.Reader
	tmp      string
	rate     int
	dead     atomic.Bool
	waitOnce sync.Once
	finished chan struct{}
	waitErr  error
}

var wavSeq atomic.Uint64

// startPiper runs exe for voice v. env, when not nil, is the process environment.
func startPiper(exe string, env []string, v Voice, lengthScale float64, tmp string, logger *log.Logger) (*piperCLI, error) {
	if v.SampleRate < 1 || v.SampleRate > 48000 {
		return nil, errors.New("voice rate must be 1 to 48000 Hz")
	}
	cmd := exec.Command(exe, "--model", v.Model, "--json-input",
		"--length_scale", strconv.FormatFloat(lengthScale, 'f', 3, 64))
	cmd.Dir = tmp
	cmd.Env = env
	cmd.Stderr = &lineLogger{log: logger, prefix: "piper[" + v.ID + "]: "}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("start piper: %w", err)
	}
	return &piperCLI{cmd: cmd, stdin: stdin, out: bufio.NewReader(stdout), tmp: tmp, rate: v.SampleRate, gate: make(chan struct{}, 1), finished: make(chan struct{})}, nil
}

func (p *piperCLI) Synthesize(ctx context.Context, sentence string) (pcm []byte, result error) {
	select {
	case p.gate <- struct{}{}:
		defer func() { <-p.gate }()
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if p.dead.Load() {
		return nil, errors.New("piper has stopped")
	}
	// Piper's JSON pipe has no request cancellation protocol. Kill this warm
	// process on cancellation; Pool already knows how to replace dead engines.
	// Wait for a racing callback before unlocking, so it cannot kill a later use.
	cancelled := make(chan struct{})
	stopCancellation := context.AfterFunc(ctx, func() {
		defer close(cancelled)
		_ = p.cmd.Process.Kill()
		_ = p.stdin.Close()
	})
	defer func() {
		if !stopCancellation() {
			<-cancelled
		}
		if err := ctx.Err(); err != nil {
			p.dead.Store(true)
			pcm, result = nil, err
		}
	}()
	path := filepath.Join(p.tmp, fmt.Sprintf("s%d-%d.wav", os.Getpid(), wavSeq.Add(1)))
	defer os.Remove(path)
	line, err := json.Marshal(map[string]string{"text": sentence, "output_file": path})
	if err != nil {
		return nil, err
	}
	if _, err := p.stdin.Write(append(line, '\n')); err != nil {
		p.dead.Store(true)
		return nil, fmt.Errorf("write to piper: %w", err)
	}
	gotBytes, err := p.out.ReadSlice('\n')
	if err != nil {
		p.dead.Store(true)
		return nil, fmt.Errorf("piper stopped: %w", err)
	}
	got := string(gotBytes)
	if filepath.Clean(strings.TrimSpace(got)) != filepath.Clean(path) {
		p.dead.Store(true)
		return nil, fmt.Errorf("piper answered %q for %q", strings.TrimSpace(got), path)
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	// Bound the WAV read before allocating it, including at most 1 MiB of
	// headers/metadata. Speaker independently caps decoded PCM at 30 seconds.
	maxWAV := int64(p.rate)*2*30 + (1 << 20)
	b, err := io.ReadAll(io.LimitReader(f, maxWAV+1))
	if err != nil {
		return nil, err
	}
	if int64(len(b)) > maxWAV {
		return nil, errors.New("Piper WAV exceeds the bounded sentence size")
	}
	pcm, rate, err := parseWAV(b)
	if err != nil {
		return nil, err
	}
	if rate != p.rate {
		return nil, fmt.Errorf("piper wrote %d Hz, the voice says %d Hz", rate, p.rate)
	}
	return pcm, nil
}

func (p *piperCLI) SampleRate() int { return p.rate }

func (p *piperCLI) Alive() bool {
	return !p.dead.Load()
}

func (p *piperCLI) Close() error {
	p.dead.Store(true)
	_ = p.stdin.Close()
	p.waitOnce.Do(func() { go func() { p.waitErr = p.cmd.Wait(); close(p.finished) }() })
	select {
	case <-p.finished:
		return p.waitErr
	case <-time.After(3 * time.Second):
		_ = p.cmd.Process.Kill()
		select {
		case <-p.finished:
			return p.waitErr
		case <-time.After(250 * time.Millisecond):
			return errors.New("Piper termination was not acknowledged")
		}
	}
}

// lineLogger writes what a child process prints to the log, one line at a time.
type lineLogger struct {
	log    *log.Logger
	prefix string
	buf    []byte
}

func (w *lineLogger) Write(b []byte) (int, error) {
	w.buf = append(w.buf, b...)
	for {
		i := bytes.IndexByte(w.buf, '\n')
		if i < 0 {
			return len(b), nil
		}
		w.log.Print(w.prefix + strings.TrimRight(string(w.buf[:i]), "\r"))
		w.buf = w.buf[i+1:]
	}
}

// Pool keeps a warm engine per voice and speed, restarts one that has stopped, and keeps at
// most max of them.
type Pool struct {
	mu      sync.Mutex
	start   func(v Voice, lengthScale float64) (Engine, error)
	engines map[string]Engine
	max     int
}

func NewPool(max int, start func(v Voice, lengthScale float64) (Engine, error)) *Pool {
	return &Pool{start: start, engines: map[string]Engine{}, max: max}
}

// Get returns the engine for v at rate (1 is the voice's own speed, 2 twice as fast).
func (p *Pool) Get(v Voice, rate float64) (Engine, error) {
	lengthScale := 1 / rate
	key := v.ID + "@" + strconv.FormatFloat(lengthScale, 'f', 3, 64)
	p.mu.Lock()
	defer p.mu.Unlock()
	if e, ok := p.engines[key]; ok {
		if e.Alive() {
			return e, nil
		}
		_ = e.Close()
		delete(p.engines, key)
	}
	for k, e := range p.engines {
		if len(p.engines) < p.max {
			break
		}
		_ = e.Close()
		delete(p.engines, k)
	}
	e, err := p.start(v, lengthScale)
	if err != nil {
		return nil, err
	}
	p.engines[key] = e
	return e, nil
}

func (p *Pool) Close() {
	p.mu.Lock()
	defer p.mu.Unlock()
	for k, e := range p.engines {
		_ = e.Close()
		delete(p.engines, k)
	}
}
