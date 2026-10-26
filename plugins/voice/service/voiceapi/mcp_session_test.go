package voiceapi

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// This is a protocol fixture, not a Delta runtime or an audio provider.
func deltaPeer(t *testing.T, name string, listen func(context.Context) (string, error)) *mcp.ClientSession {
	t.Helper()
	s := mcp.NewServer(&mcp.Implementation{Name: name, Version: "fixture-v0.6"}, nil)
	mcp.AddTool(s, &mcp.Tool{Name: "say", Description: "synthetic native admission"}, func(ctx context.Context, _ *mcp.CallToolRequest, a struct {
		Text string `json:"text"`
	}) (*mcp.CallToolResult, any, error) { return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: "Delta is saying it (say 1): synthetic admission."}}}, nil, nil })
	mcp.AddTool(s, &mcp.Tool{Name: "listen", Description: "synthetic transcript"}, func(ctx context.Context, _ *mcp.CallToolRequest, a struct {
		Timeout float64 `json:"timeout_seconds"`
	}) (*mcp.CallToolResult, any, error) { text, err := listen(ctx); if err != nil {
		return nil, nil, err
	}; return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: text}}}, nil, nil })
	st, ct := mcp.NewInMemoryTransports()
	ss, err := s.Connect(context.Background(), st, nil)
	if err != nil {
		t.Fatal(err)
	}
	cs, err := mcp.NewClient(&mcp.Implementation{Name: "voice-adapter-fixture", Version: "0"}, nil).Connect(context.Background(), ct, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cs.Close(); ss.Close() })
	return cs
}

func TestBindDeltaUsesTheExistingSDKSessionAndCatalog(t *testing.T) {
	cs := deltaPeer(t, "delta", func(context.Context) (string, error) { return "The user said (utterance 4): synthetic text", nil })
	b, err := BindDeltaSession(context.Background(), cs)
	if err != nil {
		t.Fatal(err)
	}
	if !b.Capabilities().Speak || !b.Capabilities().TranscriptWait || b.Capabilities().ServiceOutputStop || b.Capabilities().CaptureControl {
		t.Fatal(b.Capabilities())
	}
	if _, err := b.Speak(context.Background(), SpeechRequest{Text: "synthetic"}); err != nil {
		t.Fatal(err)
	}
	r, err := b.AwaitTranscript(context.Background(), ListenRequest{Timeout: 5 * time.Second})
	if err != nil || r.Text != "synthetic text" || r.NativeID != "4" {
		t.Fatal(r, err)
	}
	if _, err := cs.ListTools(context.Background(), nil); err != nil {
		t.Fatal("adapter closed its owner's session", err)
	}
}

func TestBindDeltaCancellationLeavesTheOwnerSessionUsable(t *testing.T) {
	started := make(chan struct{})
	cs := deltaPeer(t, "delta", func(ctx context.Context) (string, error) { close(started); <-ctx.Done(); return "", ctx.Err() })
	b, err := BindDeltaSession(context.Background(), cs)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { _, err := b.AwaitTranscript(ctx, ListenRequest{Timeout: time.Minute}); done <- err }()
	<-started
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("request cancellation did not return")
	}
	if _, err := b.Speak(context.Background(), SpeechRequest{Text: "still connected"}); err != nil {
		t.Fatal("owner session lost", err)
	}
}

func TestBindDeltaRefusesAnUnrelatedSession(t *testing.T) {
	cs := deltaPeer(t, "unrelated", func(context.Context) (string, error) { return "", nil })
	if _, err := BindDeltaSession(context.Background(), cs); !errors.Is(err, ErrProtocol) {
		t.Fatal(err)
	}
	if _, err := BindDeltaSession(context.Background(), nil); !errors.Is(err, ErrUnavailable) {
		t.Fatal(err)
	}
}
