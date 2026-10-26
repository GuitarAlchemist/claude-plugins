package voiceapi

import (
	"context"
	"encoding/json"
	"net/http"
	"time"
)

// HTTPCall is the existing control client's operation, injected by its owner.
// It must honor ctx and bound its response read. It never starts a service.
type HTTPCall func(context.Context, string, string, []byte, time.Duration) ([]byte, error)
type Piper struct{ call HTTPCall }

func NewPiper(call HTTPCall) *Piper { return &Piper{call: call} }
func (p *Piper) Capabilities() Capabilities {
	return Capabilities{Name: "piper-http", Speak: p.call != nil, WaitForCompletion: p.call != nil, VoiceSelection: p.call != nil, ServiceOutputStop: p.call != nil, AcousticDuplex: "unverified", EchoCancellation: "unverified"}
}

func (p *Piper) Speak(ctx context.Context, r SpeechRequest) (SpeechReceipt, error) {
	result := SpeechReceipt{RequestID: r.RequestID, Completion: CompletionUnknown}
	if err := validateSpeech(ctx, r); err != nil {
		return result, err
	}
	if p.call == nil {
		return result, ErrUnavailable
	}
	// The native service selects a voice ID, not a language or answer identity.
	if r.Language != "" || r.AnswerTo != "" {
		return result, ErrUnsupported
	}
	var rate *float64
	if r.Rate != nil {
		v := *r.Rate
		rate = &v
	}
	body, err := json.Marshal(struct {
		Text  string   `json:"text"`
		Voice string   `json:"voice,omitempty"`
		Rate  *float64 `json:"rate,omitempty"`
		Wait  bool     `json:"wait,omitempty"`
	}{r.Text, r.Voice, rate, r.Wait})
	if err != nil {
		return result, err
	}
	out, err := p.call(ctx, http.MethodPost, "/v1/say", body, SpeechTimeout(r.Wait))
	if err != nil {
		return result, err
	}
	result.Native, err = nativeCopy(out)
	if err != nil {
		return result, err
	}
	var native struct {
		ID        string `json:"id"`
		Sentences int    `json:"sentences"`
		Played    *int64 `json:"played_ms"`
		Stopped   *bool  `json:"stopped"`
	}
	if json.Unmarshal(out, &native) != nil || native.ID == "" || len(native.ID) > 128 || native.Sentences < 0 || native.Sentences > MaxTextRunes {
		return result, ErrProtocol
	}
	result.NativeID = native.ID
	if native.Stopped != nil && *native.Stopped {
		result.Completion = CompletionStopped
	} else if native.Played != nil {
		result.Completion = CompletionServiceFinished
	}
	return result, nil
}
func (p *Piper) AwaitTranscript(ctx context.Context, _ ListenRequest) (Transcript, error) {
	if err := ctx.Err(); err != nil {
		return Transcript{}, err
	}
	return Transcript{}, ErrUnsupported
}
func (p *Piper) StopOutput(ctx context.Context, r StopRequest) (StopReceipt, error) {
	result := StopReceipt{Scope: r.Scope}
	if err := ctx.Err(); err != nil {
		return result, err
	}
	if err := validateScope(r.Scope); err != nil {
		return result, err
	}
	if r.Scope != ServiceOutput {
		return result, ErrUnsupported
	}
	if p.call == nil {
		return result, ErrUnavailable
	}
	out, err := p.call(ctx, http.MethodPost, "/v1/stop", nil, 5*time.Second)
	if len(out) > 0 {
		result.Native, _ = nativeCopy(out)
	}
	if err != nil {
		return result, err
	}
	if result.Native == nil {
		return result, ErrProtocol
	}
	var native struct {
		Acknowledged *bool   `json:"acknowledged"`
		Generation   *uint64 `json:"generation"`
	}
	if json.Unmarshal(out, &native) != nil {
		return result, ErrProtocol
	}
	if native.Acknowledged == nil || !*native.Acknowledged || native.Generation == nil || *native.Generation == 0 {
		return result, ErrUnacknowledged
	}
	result.Acknowledged = true
	result.Generation = *native.Generation
	return result, nil
}
