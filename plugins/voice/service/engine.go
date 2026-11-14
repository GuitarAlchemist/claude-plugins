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
	mu    sync.Mutex
	cmd   *exec.Cmd
	stdin io.WriteCloser
	out   *bufio.Reader
	tmp   string
	rate  int
	dead  bool
}

var wavSeq atomic.Uint64

// startPiper runs exe for voice v. env, when not nil, is the process environment.
func startPiper(exe string, env []string, v Voice, lengthScale float64, tmp string, logger *log.Logger) (*piperCLI, error) {
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
	return &piperCLI{cmd: cmd, stdin: stdin, out: bufio.NewReader(stdout), tmp: tmp, rate: v.SampleRate}, nil
}

func (p *piperCLI) Synthesize(_ context.Context, sentence string) ([]byte, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.dead {
		return nil, errors.New("piper has stopped")
	}
	path := filepath.Join(p.tmp, fmt.Sprintf("s%d-%d.wav", os.Getpid(), wavSeq.Add(1)))
	defer os.Remove(path)
	line, err := json.Marshal(map[string]string{"text": sentence, "output_file": path})
	if err != nil {
		return nil, err
	}
	if _, err := p.stdin.Write(append(line, '\n')); err != nil {
		p.dead = true
		return nil, fmt.Errorf("write to piper: %w", err)
	}
	got, err := p.out.ReadString('\n')
	if err != nil {
		p.dead = true
		return nil, fmt.Errorf("piper stopped: %w", err)
	}
	if filepath.Clean(strings.TrimSpace(got)) != filepath.Clean(path) {
		p.dead = true
		return nil, fmt.Errorf("piper answered %q for %q", strings.TrimSpace(got), path)
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
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
	p.mu.Lock()
	defer p.mu.Unlock()
	return !p.dead
}

func (p *piperCLI) Close() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.dead = true
	_ = p.stdin.Close()
	done := make(chan error, 1)
	go func() { done <- p.cmd.Wait() }()
	select {
	case err := <-done:
		return err
	case <-time.After(3 * time.Second):
		_ = p.cmd.Process.Kill()
		return <-done
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
