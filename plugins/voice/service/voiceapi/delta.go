package voiceapi

import (
	"context"
	"fmt"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"
)

// MCPCall uses a caller-owned existing connection. Implementations must honor
// ctx; cancellation ends this request, not shared capture or native playback.
type MCPCall func(context.Context, string, map[string]any) (ToolReply, error)
type ToolReply struct {
	Text    []string
	IsError bool
}
type DeltaCatalog struct {
	Version string
	Tools   []string
}
type Delta struct {
	call         MCPCall
	capabilities Capabilities
}

// NewDeltaMCP adapts the characterized Delta v0.6 text-tool dialect. The catalog
// comes from its owner, not a process started or a configuration read here.
func NewDeltaMCP(call MCPCall, catalog DeltaCatalog) *Delta {
	c := Capabilities{Name: "delta-mcp", Version: catalog.Version, AcousticDuplex: "unverified", EchoCancellation: "unverified"}
	if call != nil {
		for _, name := range catalog.Tools {
			if name == "say" {
				c.Speak = true
				c.LanguageSelection = true
			}
			if name == "listen" {
				c.TranscriptWait = true
			}
		}
	}
	return &Delta{call: call, capabilities: c}
}
func (d *Delta) Capabilities() Capabilities { return d.capabilities }
func (d *Delta) invoke(ctx context.Context, name string, args map[string]any) ([]byte, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if d.call == nil {
		return nil, ErrUnavailable
	}
	r, err := d.call(ctx, name, args)
	if err != nil {
		return nil, err
	}
	if len(r.Text) != 1 || len(r.Text[0]) > MaxControlReply || !utf8.ValidString(r.Text[0]) {
		return nil, ErrProtocol
	}
	out := []byte(r.Text[0])
	if r.IsError {
		return nil, fmt.Errorf("%w: %s", ErrNativeRefused, r.Text[0])
	}
	return out, nil
}
func (d *Delta) Speak(ctx context.Context, r SpeechRequest) (SpeechReceipt, error) {
	result := SpeechReceipt{RequestID: r.RequestID, Completion: CompletionUnknown}
	if err := validateSpeech(ctx, r); err != nil {
		return result, err
	}
	if !d.capabilities.Speak {
		return result, ErrUnsupported
	}
	if r.Wait || r.Voice != "" || r.Rate != nil {
		return result, ErrUnsupported
	}
	args := map[string]any{"text": r.Text}
	if r.Language != "" {
		args["language"] = r.Language
	}
	if r.AnswerTo != "" {
		args["utterance_id"] = r.AnswerTo
	}
	out, err := d.invoke(ctx, "say", args)
	if err != nil {
		return result, err
	}
	result.Native = out
	// IDs are deliberately not inferred from a human-facing admission sentence.
	return result, nil
}

var deltaTranscript = regexp.MustCompile(`(?s)^The user said \(utterance ([0-9]{1,19})\): (.*)$`)
var deltaNoTranscript = regexp.MustCompile(`^Nothing heard in [0-9]+ s\.$`)

func (d *Delta) AwaitTranscript(ctx context.Context, r ListenRequest) (Transcript, error) {
	result := Transcript{Source: "delta-mcp"}
	if err := ctx.Err(); err != nil {
		return result, err
	}
	if !d.capabilities.TranscriptWait {
		return result, ErrUnsupported
	}
	if r.Timeout == 0 {
		r.Timeout = time.Minute
	}
	if r.Timeout < 5*time.Second || r.Timeout > 300*time.Second {
		return result, ErrInvalidRequest
	}
	ctx, cancel := context.WithTimeout(ctx, r.Timeout+time.Second)
	defer cancel()
	out, err := d.invoke(ctx, "listen", map[string]any{"timeout_seconds": r.Timeout.Seconds()})
	if err != nil {
		return result, err
	}
	result.Native = out
	if deltaNoTranscript.Match(out) {
		return result, ErrNoTranscript
	}
	parts := deltaTranscript.FindStringSubmatch(string(out))
	if len(parts) != 3 || strings.TrimSpace(parts[2]) == "" || utf8.RuneCountInString(parts[2]) > MaxTextRunes {
		return result, ErrProtocol
	}
	result.NativeID = parts[1]
	result.Text = parts[2]
	return result, nil
}
func (d *Delta) StopOutput(ctx context.Context, r StopRequest) (StopReceipt, error) {
	result := StopReceipt{Scope: r.Scope}
	if err := ctx.Err(); err != nil {
		return result, err
	}
	if err := validateScope(r.Scope); err != nil {
		return result, err
	}
	// No characterized output-purge tool exists in this dialect. Cancelling a
	// pending listen is not output cancellation and does not close the mic.
	return result, ErrUnsupported
}
