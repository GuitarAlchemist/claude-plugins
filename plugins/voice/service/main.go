// Command piper-voice is a local text-to-speech service: it speaks text aloud, sentence by
// sentence, with Piper voices kept warm. It listens on 127.0.0.1 only.
//
//	piper-voice setup [--english]   download the Piper engine and voices (pinned SHA-256)
//	piper-voice serve [--addr A] [--voice V]
//	piper-voice say [--voice V] [--rate R] [--wait] <text>
//	piper-voice stop | status | voices
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

const (
	version     = "0.1.0"
	defaultAddr = "127.0.0.1:59126"
	defaultVoc  = "fr_FR-siwis-medium"
)

func main() {
	if len(os.Args) < 2 {
		usage()
	}
	var err error
	switch cmd, args := os.Args[1], os.Args[2:]; cmd {
	case "setup":
		err = setupCmd(args)
	case "serve":
		err = serveCmd(args)
	case "say":
		err = sayCmd(args)
	case "stop":
		err = call(http.MethodPost, "/v1/stop", nil, 5*time.Second)
	case "status":
		err = call(http.MethodGet, "/health", nil, 5*time.Second)
	case "voices":
		err = call(http.MethodGet, "/v1/voices", nil, 5*time.Second)
	default:
		usage()
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "piper-voice:", err)
		os.Exit(1)
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: piper-voice setup [--english] | serve [--addr A] [--voice V] | say [--voice V] [--rate R] [--wait] <text> | stop | status | voices")
	os.Exit(2)
}

func envOr(name, def string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return def
}

// home is the data folder: PIPER_VOICE_HOME, else piper-voice under the user's cache folder
// (%LOCALAPPDATA% on Windows).
func home() (string, error) {
	if h := os.Getenv("PIPER_VOICE_HOME"); h != "" {
		return h, nil
	}
	c, err := os.UserCacheDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(c, "piper-voice"), nil
}

func setupCmd(args []string) error {
	fs := flag.NewFlagSet("setup", flag.ExitOnError)
	english := fs.Bool("english", false, "also install the English voice en_US-ljspeech-medium")
	_ = fs.Parse(args)
	if runtime.GOOS != "windows" || runtime.GOARCH != "amd64" {
		return errors.New("setup pins the Windows amd64 Piper release only; install piper yourself under <home>/engine/piper")
	}
	h, err := home()
	if err != nil {
		return err
	}
	pins := append([]pin{enginePin}, frenchPins...)
	if *english {
		pins = append(pins, englishPins...)
	}
	client := &http.Client{Timeout: 10 * time.Minute}
	return install(h, pins, client, func(s string) { fmt.Println(s) })
}

func serveCmd(args []string) error {
	fs := flag.NewFlagSet("serve", flag.ExitOnError)
	addr := fs.String("addr", envOr("PIPER_VOICE_ADDR", defaultAddr), "listen address, loopback only")
	voice := fs.String("voice", envOr("PIPER_VOICE_VOICE", defaultVoc), "default voice")
	_ = fs.Parse(args)
	if err := loopbackOnly(*addr); err != nil {
		return err
	}
	logger := log.New(os.Stderr, "", log.LstdFlags|log.Lmicroseconds)
	h, err := home()
	if err != nil {
		return err
	}
	voices, err := scanVoices(filepath.Join(h, "voices"))
	if err != nil {
		return err
	}
	def, ok := findVoice(voices, *voice)
	if !ok {
		return fmt.Errorf("no voice %q in %s (run piper-voice setup); installed: %s", *voice, filepath.Join(h, "voices"), voiceIDs(voices))
	}
	exe := filepath.Join(h, "engine", "piper", "piper")
	if runtime.GOOS == "windows" {
		exe += ".exe"
	}
	if _, err := os.Stat(exe); err != nil {
		return fmt.Errorf("no Piper engine at %s (run piper-voice setup)", exe)
	}
	tmp := filepath.Join(h, "tmp")
	if err := os.MkdirAll(tmp, 0o755); err != nil {
		return err
	}
	player, err := newPlayer(def.SampleRate)
	if err != nil {
		return fmt.Errorf("audio output: %w", err)
	}
	pool := NewPool(4, func(v Voice, lengthScale float64) (Engine, error) {
		return startPiper(exe, nil, v, lengthScale, tmp, logger)
	})
	defer pool.Close()
	srv := &Server{Speaker: NewSpeaker(pool.Get, player, logger), Voices: voices, DefaultVoice: def.ID,
		Engine: "piper-cli", SampleRate: player.SampleRate(), MaxText: 20000}
	ln, err := net.Listen("tcp", *addr)
	if err != nil {
		return err
	}
	logger.Printf("piper-voice %s on http://%s, default voice %s, voices: %s", version, ln.Addr(), def.ID, voiceIDs(voices))
	go func() {
		if _, err := pool.Get(def, 1); err != nil {
			logger.Printf("warming %s: %v", def.ID, err)
		}
	}()
	hs := &http.Server{Handler: srv.Handler(), ReadHeaderTimeout: 10 * time.Second}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	go func() {
		<-ctx.Done()
		_ = hs.Shutdown(context.Background())
	}()
	if err := hs.Serve(ln); !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

func sayCmd(args []string) error {
	fs := flag.NewFlagSet("say", flag.ExitOnError)
	voice := fs.String("voice", "", "voice id (default: the service's)")
	rate := fs.Float64("rate", 1, "speed, from 0.5 to 2")
	wait := fs.Bool("wait", false, "answer once it has been spoken")
	_ = fs.Parse(args)
	text := strings.Join(fs.Args(), " ")
	if text == "" {
		return errors.New("say what? usage: piper-voice say [--voice V] [--rate R] [--wait] <text>")
	}
	body, _ := json.Marshal(sayRequest{Text: text, Voice: *voice, Rate: rate, Wait: *wait})
	timeout := 10 * time.Second
	if *wait {
		timeout = 10 * time.Minute
	}
	return call(http.MethodPost, "/v1/say", body, timeout)
}

// call sends one request to the running service and prints its answer.
func call(method, path string, body []byte, timeout time.Duration) error {
	addr := envOr("PIPER_VOICE_ADDR", defaultAddr)
	req, err := http.NewRequest(method, "http://"+addr+path, bytes.NewReader(body))
	if err != nil {
		return err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := (&http.Client{Timeout: timeout}).Do(req)
	if err != nil {
		return fmt.Errorf("the service is not answering on %s (start it with: piper-voice serve): %w", addr, err)
	}
	defer resp.Body.Close()
	out, err := io.ReadAll(resp.Body)
	if err != nil {
		return err
	}
	fmt.Print(string(out))
	if resp.StatusCode >= 400 {
		return fmt.Errorf("%s %s: %s", method, path, resp.Status)
	}
	return nil
}
