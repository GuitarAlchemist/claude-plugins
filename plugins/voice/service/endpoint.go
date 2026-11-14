package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
)

// sttRate is the sample rate speech is transcribed at: whisper's own.
const sttRate = 16000

// Resampler converts 16-bit mono PCM from one rate to another by linear interpolation, keeping
// its place between calls so a stream fed in pieces has no seam.
type Resampler struct {
	From, To int
	pos      float64 // position of the next output sample, in input samples, relative to last
	last     int16
	primed   bool
}

// Feed converts one piece of the stream.
func (r *Resampler) Feed(pcm []byte) []byte {
	if r.From == r.To || r.From <= 0 || r.To <= 0 {
		return pcm
	}
	n := len(pcm) / 2
	if n == 0 {
		return nil
	}
	in := make([]int16, n+1)
	for i := 0; i < n; i++ {
		in[i+1] = int16(binary.LittleEndian.Uint16(pcm[2*i:]))
	}
	if !r.primed {
		r.last, r.primed = in[1], true
	}
	in[0] = r.last
	step := float64(r.From) / float64(r.To)
	out := make([]byte, 0, int(float64(n)/step)*2+2)
	// positions are measured from in[0] (the carried sample); outputs lie strictly before in[n].
	for p := r.pos; p < float64(n); p += step {
		i := int(p)
		f := p - float64(i)
		s := float64(in[i])*(1-f) + float64(in[i+1])*f
		out = binary.LittleEndian.AppendUint16(out, uint16(int16(math.Round(s))))
		r.pos = p + step
	}
	r.pos -= float64(n)
	r.last = in[n]
	return out
}

// Endpointer cuts a stream of 16-bit mono PCM into utterances by energy: an utterance opens
// with the first loud window (keeping Lead of what came before), and closes after Silence of
// quiet ones, or at MaxLen. One with less than MinSpeech of loud windows is dropped.
type Endpointer struct {
	Rate      int           // samples per second
	Threshold float64       // RMS, as a fraction of full scale (0.015 ≈ -36 dBFS)
	Window    time.Duration // one energy measurement
	Silence   time.Duration
	MinSpeech time.Duration
	MaxLen    time.Duration
	Lead      time.Duration

	rest    []byte // less than one window, waiting for the next feed
	lead    []byte // the last Lead of quiet audio
	seg     []byte // the open utterance
	quiet   int    // bytes of quiet since the last loud window of the open utterance
	loud    int    // bytes of loud windows in the open utterance
	Started bool   // an utterance is open
}

// NewEndpointer has the defaults speech at rate is cut with.
func NewEndpointer(rate int) *Endpointer {
	return &Endpointer{Rate: rate, Threshold: 0.015, Window: 20 * time.Millisecond, Silence: 700 * time.Millisecond,
		MinSpeech: 300 * time.Millisecond, MaxLen: 20 * time.Second, Lead: 200 * time.Millisecond}
}

func (e *Endpointer) bytesOf(d time.Duration) int {
	n := int(d.Seconds()*float64(e.Rate)) * 2
	if n < 2 {
		n = 2
	}
	return n
}

// Cut is one closed utterance: Start is true for the event that opened it (PCM then nil).
type Cut struct {
	Start bool
	PCM   []byte
}

// Feed takes the next piece of the stream and returns what it closed, in order.
func (e *Endpointer) Feed(pcm []byte) []Cut {
	var cuts []Cut
	win := e.bytesOf(e.Window)
	buf := append(e.rest, pcm...)
	for len(buf) >= win {
		w := buf[:win]
		buf = buf[win:]
		loud := pcmRMS(w) >= e.Threshold
		if !e.Started {
			if !loud {
				e.lead = append(e.lead, w...)
				if max := e.bytesOf(e.Lead); len(e.lead) > max {
					e.lead = append([]byte(nil), e.lead[len(e.lead)-max:]...)
				}
				continue
			}
			e.seg = append(append([]byte(nil), e.lead...), w...)
			e.lead = e.lead[:0]
			e.loud, e.quiet, e.Started = win, 0, true
			cuts = append(cuts, Cut{Start: true})
			continue
		}
		e.seg = append(e.seg, w...)
		if loud {
			e.loud += win
			e.quiet = 0
		} else {
			e.quiet += win
		}
		if e.quiet >= e.bytesOf(e.Silence) || len(e.seg) >= e.bytesOf(e.MaxLen) {
			if c, ok := e.close(); ok {
				cuts = append(cuts, c)
			}
		}
	}
	e.rest = append(e.rest[:0], buf...)
	return cuts
}

// Flush closes the open utterance now, if there is one worth keeping.
func (e *Endpointer) Flush() (Cut, bool) {
	if !e.Started {
		return Cut{}, false
	}
	return e.close()
}

func (e *Endpointer) close() (Cut, bool) {
	seg, loud := e.seg, e.loud
	e.seg, e.loud, e.quiet, e.Started = nil, 0, 0, false
	if loud < e.bytesOf(e.MinSpeech) {
		return Cut{}, false
	}
	// drop the trailing silence beyond what whisper needs to close the last word
	if keep := len(seg) - e.quietTail(seg); keep > 0 && keep < len(seg) {
		seg = seg[:keep]
	}
	return Cut{PCM: seg}, true
}

// quietTail is how many bytes at the end of seg to drop: everything past 300 ms of silence.
func (e *Endpointer) quietTail(seg []byte) int {
	win := e.bytesOf(e.Window)
	quiet := 0
	for p := len(seg) - win; p >= 0; p -= win {
		if pcmRMS(seg[p:p+win]) >= e.Threshold {
			break
		}
		quiet += win
	}
	if keep := e.bytesOf(300 * time.Millisecond); quiet > keep {
		return quiet - keep
	}
	return 0
}

// pcmRMS is the root mean square of 16-bit samples, as a fraction of full scale.
func pcmRMS(pcm []byte) float64 {
	n := len(pcm) / 2
	if n == 0 {
		return 0
	}
	var sum float64
	for i := 0; i < n; i++ {
		s := float64(int16(binary.LittleEndian.Uint16(pcm[2*i:]))) / 32768
		sum += s * s
	}
	return math.Sqrt(sum / float64(n))
}

// Transcriber turns 16-bit mono PCM at sttRate into words.
type Transcriber interface {
	Name() string
	Transcribe(ctx context.Context, pcm []byte) (string, error)
}

// whisperCLI runs whisper.cpp's command-line tool once per utterance.
type whisperCLI struct {
	exe, model, lang string
	threads          int
	tmp              string
	seq              atomic.Uint64
}

func (w *whisperCLI) Name() string { return "whisper-cli" }

func (w *whisperCLI) Transcribe(ctx context.Context, pcm []byte) (string, error) {
	path := filepath.Join(w.tmp, fmt.Sprintf("m%d-%d.wav", os.Getpid(), w.seq.Add(1)))
	if err := os.WriteFile(path, append(wavHeader(sttRate, len(pcm)), pcm...), 0o600); err != nil {
		return "", err
	}
	defer os.Remove(path)
	cmd := exec.CommandContext(ctx, w.exe, "-m", w.model, "-l", w.lang, "-t", strconv.Itoa(w.threads),
		"--no-timestamps", "--no-prints", "-f", path)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		msg := strings.TrimSpace(stderr.String())
		if i := strings.LastIndexByte(msg, '\n'); i >= 0 {
			msg = msg[i+1:]
		}
		return "", fmt.Errorf("whisper: %w: %s", err, msg)
	}
	return cleanTranscript(string(out)), nil
}

// cleanTranscript joins whisper's lines and drops its sound tags ("[BLANK_AUDIO]", "(music)").
func cleanTranscript(out string) string {
	var words []string
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "[") && strings.HasSuffix(line, "]") ||
			strings.HasPrefix(line, "(") && strings.HasSuffix(line, ")") {
			continue
		}
		words = append(words, line)
	}
	return strings.Join(words, " ")
}

// findWhisper looks for a whisper.cpp install the way the voice listener leaves one: the tool
// under <cache>/voice-listen/whisper-*/Release and a model under <cache>/voice-listen/models.
// An explicit exe or model wins over the search. lang picks between English-only and
// multilingual models.
func findWhisper(cacheDir, exe, model, lang string) (string, string, error) {
	base := filepath.Join(cacheDir, "voice-listen")
	if exe == "" {
		name := "whisper-cli"
		if runtime.GOOS == "windows" {
			name += ".exe"
		}
		hits, _ := filepath.Glob(filepath.Join(base, "whisper-*", "Release", name))
		if len(hits) == 0 {
			hits, _ = filepath.Glob(filepath.Join(base, "whisper-*", name))
		}
		if len(hits) == 0 {
			return "", "", fmt.Errorf("no %s under %s", name, base)
		}
		sort.Strings(hits)
		exe = hits[len(hits)-1]
	} else if _, err := os.Stat(exe); err != nil {
		return "", "", err
	}
	if model == "" {
		hits, _ := filepath.Glob(filepath.Join(base, "models", "ggml-*.bin"))
		var usable []string
		for _, h := range hits {
			if strings.HasSuffix(h, ".en.bin") && !strings.HasPrefix(lang, "en") {
				continue
			}
			usable = append(usable, h)
		}
		if len(usable) == 0 {
			return "", "", fmt.Errorf("no ggml-*.bin model under %s", filepath.Join(base, "models"))
		}
		sort.Slice(usable, func(i, j int) bool {
			ti, tj := strings.Contains(usable[i], "large-v3-turbo"), strings.Contains(usable[j], "large-v3-turbo")
			if ti != tj {
				return ti
			}
			return usable[i] < usable[j]
		})
		model = usable[0]
	} else if _, err := os.Stat(model); err != nil {
		return "", "", err
	}
	return exe, model, nil
}

// newWhisper is a whisperCLI over exe and model, speaking lang, with its WAV files under tmp.
func newWhisper(exe, model, lang, tmp string, threads int) (*whisperCLI, error) {
	if lang == "" {
		return nil, errors.New("whisper needs a language")
	}
	if threads <= 0 {
		threads = runtime.NumCPU() / 2
		if threads < 1 {
			threads = 1
		}
		if threads > 8 {
			threads = 8
		}
	}
	return &whisperCLI{exe: exe, model: model, lang: lang, threads: threads, tmp: tmp}, nil
}
