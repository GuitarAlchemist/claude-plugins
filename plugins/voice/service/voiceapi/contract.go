// Package voiceapi adapts existing voice control interfaces. It owns no audio
// engine, queue, device, subprocess, signaling server or client connection.
package voiceapi

import (
	"context"
	"errors"
	"math"
	"strings"
	"time"
	"unicode/utf8"
)

const MaxTextRunes = 20000
const MaxControlReply = 1 << 20

var (
	ErrUnsupported    = errors.New("operation or option is unsupported by this adapter")
	ErrInvalidRequest = errors.New("invalid voice request")
	ErrProtocol       = errors.New("unrecognized or oversized native control reply")
	ErrUnacknowledged = errors.New("native output purge was not acknowledged")
	ErrNoTranscript   = errors.New("no transcript before the native wait ended")
	ErrUnavailable    = errors.New("native voice control connection is unavailable")
	ErrNativeRefused  = errors.New("native voice backend refused the request")
)

type Capabilities struct {
	Name, Version                                        string
	Speak, TranscriptWait, CaptureControl                bool
	WaitForCompletion, LanguageSelection, VoiceSelection bool
	ServiceOutputStop                                    bool
	// These are evidence states, not claims inferred from tools or a loaded UI.
	AcousticDuplex, EchoCancellation string
}

type Backend interface {
	Capabilities() Capabilities
	Speak(context.Context, SpeechRequest) (SpeechReceipt, error)
	AwaitTranscript(context.Context, ListenRequest) (Transcript, error)
	StopOutput(context.Context, StopRequest) (StopReceipt, error)
}

type SpeechRequest struct {
	Text, Language, Voice string
	RequestID             string // caller correlation; never confused with a native utterance ID
	AnswerTo              string // native utterance being answered, when supported
	Rate                  *float64
	Wait                  bool
}

type Completion string

const (
	CompletionUnknown         Completion = "unknown"
	CompletionServiceFinished Completion = "service-finished"
	CompletionStopped         Completion = "stopped"
)

type SpeechReceipt struct {
	RequestID, NativeID string
	Completion          Completion
	Native              []byte `json:"-"` // caller-owned copy; adapters do not log/store it
}

type ListenRequest struct{ Timeout time.Duration }
type Transcript struct {
	Text, Language, Source, NativeID string
	Native                           []byte `json:"-"`
}

type OutputScope string

const (
	ServiceOutput OutputScope = "service"
	RequestOutput OutputScope = "request"
)

type StopRequest struct{ Scope OutputScope }
type StopReceipt struct {
	Scope        OutputScope
	Acknowledged bool
	Generation   uint64
	Native       []byte `json:"-"`
}

func validateSpeech(ctx context.Context, r SpeechRequest) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if !utf8.ValidString(r.Text) || strings.TrimSpace(r.Text) == "" || utf8.RuneCountInString(r.Text) > MaxTextRunes {
		return ErrInvalidRequest
	}
	for _, s := range []string{r.RequestID, r.AnswerTo, r.Language, r.Voice} {
		if !utf8.ValidString(s) || len(s) > 128 {
			return ErrInvalidRequest
		}
	}
	if r.Rate != nil {
		v := *r.Rate
		if math.IsNaN(v) || math.IsInf(v, 0) || v < 0.5 || v > 2 {
			return ErrInvalidRequest
		}
	}
	return nil
}
func validateScope(s OutputScope) error {
	if s != ServiceOutput && s != RequestOutput {
		return ErrInvalidRequest
	}
	return nil
}
func nativeCopy(b []byte) ([]byte, error) {
	if len(b) > MaxControlReply || !utf8.Valid(b) {
		return nil, ErrProtocol
	}
	return append([]byte(nil), b...), nil
}

// SpeechTimeout retains the existing service client's admission/completion budgets.
func SpeechTimeout(wait bool) time.Duration {
	if wait {
		return 10 * time.Minute
	}
	return 10 * time.Second
}
