// Command piper-voice is a local text-to-speech service: it speaks text aloud, sentence by
// sentence, with Piper voices kept warm. It listens on 127.0.0.1 only.
//
//	piper-voice setup [--english]   download the Piper engine and voices (pinned SHA-256)
//	piper-voice serve [--addr A] [--voice V] [--fx none|warm] [--log FILE]
//	piper-voice say [--voice V] [--rate R] [--wait] <text>
//	piper-voice stop | status | voices
//	piper-voice mcp                 an MCP server over stdio that drives the running service
//	piper-voice install [--print] | uninstall   start at logon (HKCU Run), no admin needed
package main

import (
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
	case "mcp":
		err = mcpCmd()
	case "install", "uninstall":
		err = autostartCmd(cmd, args)
	default:
		usage()
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "piper-voice:", err)
		os.Exit(1)
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: piper-voice setup [--english] | serve [--addr A] [--voice V] [--fx none|warm] [--log FILE] | say [--voice V] [--rate R] [--wait] <text> | stop | status | voices | mcp | install [--print] | uninstall")
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

func serveCmd(args []string) (err error) {
	fs := flag.NewFlagSet("serve", flag.ExitOnError)
	addr := fs.String("addr", envOr("PIPER_VOICE_ADDR", defaultAddr), "listen address, loopback only")
	voice := fs.String("voice", envOr("PIPER_VOICE_VOICE", defaultVoc), "default voice")
	fxName := fs.String("fx", envOr("PIPER_VOICE_FX", "none"), "effect on played speech: none or warm")
	logFile := fs.String("log", "", "append the log to this file instead of stderr (the windowless build has no console)")
	whisper := fs.String("whisper", envOr("PIPER_VOICE_WHISPER", ""), "whisper-cli executable that transcribes WebRTC sessions (default: the voice-listen install under the cache folder; \"off\" serves speech only)")
	whisperModel := fs.String("whisper-model", envOr("PIPER_VOICE_WHISPER_MODEL", ""), "whisper ggml model file (default: the voice-listen install's)")
	whisperLang := fs.String("whisper-lang", envOr("PIPER_VOICE_WHISPER_LANG", ""), "language spoken to the microphone (default: the default voice's)")
	whisperThreads := fs.Int("whisper-threads", 0, "threads whisper runs on (default: half the CPUs, at most 8)")
	_ = fs.Parse(args)
	var logOut io.Writer = os.Stderr
	if *logFile != "" {
		if err := os.MkdirAll(filepath.Dir(*logFile), 0o755); err != nil {
			return err
		}
		f, err := os.OpenFile(*logFile, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
		if err != nil {
			return err
		}
		defer f.Close()
		logOut = f
	}
	logger := log.New(logOut, "", log.LstdFlags|log.Lmicroseconds)
	defer func() {
		if err != nil {
			logger.Printf("serve: %v", err)
		}
	}()
	if err := loopbackOnly(*addr); err != nil {
		return err
	}
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
	fx, err := effects(*fxName, player.SampleRate())
	if err != nil {
		return err
	}
	pool := NewPool(4, func(v Voice, lengthScale float64) (Engine, error) {
		return startPiper(exe, nil, v, lengthScale, tmp, logger)
	})
	defer pool.Close()
	rtc := &RTC{Engines: pool.Get, Voices: voices, DefaultVoice: def.ID, SampleRate: def.SampleRate, MaxText: 20000, Log: logger}
	defer rtc.Close()
	if *whisper != "off" {
		lang := *whisperLang
		if lang == "" {
			lang, _, _ = strings.Cut(def.Language, "_")
		}
		cache, _ := os.UserCacheDir()
		exe, model, err := findWhisper(cache, *whisper, *whisperModel, lang)
		if err != nil {
			logger.Printf("no transcription for WebRTC sessions: %v (see --whisper)", err)
		} else if rtc.Transcriber, err = newWhisper(exe, model, lang, tmp, *whisperThreads); err != nil {
			return err
		} else {
			logger.Printf("whisper: %s with %s, language %s", exe, filepath.Base(model), lang)
		}
	}
	srv := &Server{Speaker: NewSpeaker(pool.Get, player, fx, logger), Engines: pool.Get, Voices: voices, DefaultVoice: def.ID,
		Engine: "piper-cli", SampleRate: player.SampleRate(), MaxText: 20000, RTC: rtc}
	ln, err := net.Listen("tcp", *addr)
	if err != nil {
		return err
	}
	logger.Printf("piper-voice %s on http://%s, default voice %s, effect %s, voices: %s; WebRTC page at http://%s/rtc", version, ln.Addr(), def.ID, *fxName, voiceIDs(voices), ln.Addr())
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
	return call(http.MethodPost, "/v1/say", body, sayTimeout(*wait))
}

func autostartCmd(cmd string, args []string) error {
	key, err := openRunKey()
	if err != nil {
		return err
	}
	if cmd == "uninstall" {
		return uninstallCmd(key, os.Stdout)
	}
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	h, err := home()
	if err != nil {
		return err
	}
	return installCmd(args, key, filepath.Dir(exe), h, os.Stdout)
}

// call sends one request to the running service and prints its answer.
func call(method, path string, body []byte, timeout time.Duration) error {
	out, err := serviceClient{addr: envOr("PIPER_VOICE_ADDR", defaultAddr)}.do(context.Background(), method, path, body, timeout)
	fmt.Print(string(out))
	return err
}
