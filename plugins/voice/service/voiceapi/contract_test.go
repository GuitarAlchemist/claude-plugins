package voiceapi

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestSharedSpeakContract(t *testing.T) {
	for _, kind := range []string{"piper", "delta"} {
		t.Run(kind, func(t *testing.T) {
			var mu sync.Mutex
			calls := 0
			var received []string
			var b Backend
			if kind == "piper" {
				b = NewPiper(func(ctx context.Context, method, path string, body []byte, timeout time.Duration) ([]byte, error) {
					if method != "POST" || path != "/v1/say" {
						t.Fatalf("unexpected native operation %s %s", method, path)
					}
					var a struct{ Text string }
					if err := json.Unmarshal(body, &a); err != nil {
						t.Fatal(err)
					}
					mu.Lock()
					calls++
					received = append(received, a.Text)
					mu.Unlock()
					return []byte(`{"id":"u1","sentences":1}`), nil
				})
			} else {
				b = NewDeltaMCP(func(ctx context.Context, name string, args map[string]any) (ToolReply, error) {
					if name != "say" {
						t.Fatalf("unexpected native operation %s", name)
					}
					mu.Lock()
					calls++
					received = append(received, args["text"].(string))
					mu.Unlock()
					return ToolReply{Text: []string{"Delta is saying it (say 1): 2 words, about 1 s."}}, nil
				}, DeltaCatalog{Version: "source-characterization", Tools: []string{"say", "listen"}})
			}
			if !b.Capabilities().Speak || b.Capabilities().AcousticDuplex != "unverified" || b.Capabilities().EchoCancellation != "unverified" {
				t.Fatal(b.Capabilities())
			}
			for _, text := range []string{"", strings.Repeat("界", 20001), string([]byte{255})} {
				if _, err := b.Speak(context.Background(), SpeechRequest{Text: text}); !errors.Is(err, ErrInvalidRequest) {
					t.Fatalf("invalid text admitted: %v", err)
				}
			}
			ctx, cancel := context.WithCancel(context.Background())
			cancel()
			if _, err := b.Speak(ctx, SpeechRequest{Text: "not admitted"}); !errors.Is(err, context.Canceled) {
				t.Fatal(err)
			}
			if calls != 0 {
				t.Fatal("invalid/cancelled operation reached native backend")
			}
			var wg sync.WaitGroup
			for _, id := range []string{"caller-one", "caller-two"} {
				wg.Add(1)
				go func(id string) {
					defer wg.Done()
					r, err := b.Speak(context.Background(), SpeechRequest{Text: id, RequestID: id})
					if err != nil || r.RequestID != id || r.Completion != CompletionUnknown {
						t.Errorf("%+v %v", r, err)
					}
				}(id)
			}
			wg.Wait()
			if calls != 2 || len(received) != 2 {
				t.Fatal(calls, received)
			}
			if _, err := b.StopOutput(context.Background(), StopRequest{Scope: RequestOutput}); !errors.Is(err, ErrUnsupported) {
				t.Fatal("invented caller-only stop", err)
			}
		})
	}
}

func TestPiperPreservesNativeReceiptAndRequiresStopAcknowledgement(t *testing.T) {
	native := []byte(`{"id":"u8","sentences":1,"played_ms":20,"stopped":false}`)
	stop := []byte(`{"stopped":1,"acknowledged":true,"generation":8}`)
	b := NewPiper(func(_ context.Context, _, path string, _ []byte, _ time.Duration) ([]byte, error) {
		if path == "/v1/stop" {
			return stop, nil
		}
		return native, nil
	})
	r, err := b.Speak(context.Background(), SpeechRequest{Text: "synthetic", Wait: true})
	if err != nil || r.Completion != CompletionServiceFinished || string(r.Native) != string(native) {
		t.Fatal(r, err)
	}
	native[0] = '!'
	if r.Native[0] != '{' {
		t.Fatal("receipt aliases transport buffer")
	}
	s, err := b.StopOutput(context.Background(), StopRequest{Scope: ServiceOutput})
	if err != nil || !s.Acknowledged || s.Generation != 8 || s.Scope != ServiceOutput {
		t.Fatal(s, err)
	}
	for _, body := range []string{`{"stopped":1}`, `{"acknowledged":false,"generation":9}`, `{"acknowledged":true}`, `{"acknowledged":true,"generation":0}`} {
		stop = []byte(body)
		s, err = b.StopOutput(context.Background(), StopRequest{Scope: ServiceOutput})
		if err == nil || s.Acknowledged {
			t.Fatalf("invented purge: %+v %v", s, err)
		}
	}
}

func TestDeltaPreservesLanguageAnswerAndOnlyCancelsTheListenWait(t *testing.T) {
	started := make(chan struct{})
	b := NewDeltaMCP(func(ctx context.Context, name string, args map[string]any) (ToolReply, error) {
		if name == "say" {
			if args["language"] != "fr" || args["utterance_id"] != "42" {
				t.Fatal(args)
			}
			return ToolReply{Text: []string{"Delta is saying it (say 9, answering utterance 42): synthetic."}}, nil
		}
		if name != "listen" {
			t.Fatal("adapter tried capture control", name)
		}
		close(started)
		<-ctx.Done()
		return ToolReply{}, ctx.Err()
	}, DeltaCatalog{Version: "source-characterization", Tools: []string{"say", "listen", "language", "window", "shelf"}})
	r, err := b.Speak(context.Background(), SpeechRequest{Text: "synthetic", Language: "fr", AnswerTo: "42"})
	if err != nil || r.Completion != CompletionUnknown {
		t.Fatal(r, err)
	}
	ctx, cancel := context.WithCancel(context.Background())
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
		t.Fatal("caller cancellation lost")
	}
	if b.Capabilities().CaptureControl {
		t.Fatal("MCP listen wait became microphone ownership")
	}
	if s, err := b.StopOutput(context.Background(), StopRequest{Scope: ServiceOutput}); !errors.Is(err, ErrUnsupported) || s.Acknowledged {
		t.Fatal(s, err)
	}
}

func TestDeltaTranscriptDialectIsStrictAndUnsupportedOptionsDoNotLeak(t *testing.T) {
	calls := 0
	reply := "The user said (utterance 17): synthetic question"
	b := NewDeltaMCP(func(context.Context, string, map[string]any) (ToolReply, error) {
		calls++
		return ToolReply{Text: []string{reply}}, nil
	}, DeltaCatalog{Tools: []string{"say", "listen"}})
	for _, r := range []SpeechRequest{{Text: "x", Wait: true}, {Text: "x", Voice: "a"}, {Text: "x", Rate: rate(1.5)}} {
		if _, err := b.Speak(context.Background(), r); !errors.Is(err, ErrUnsupported) {
			t.Fatal(err)
		}
	}
	if calls != 0 {
		t.Fatal("unsupported options silently discarded")
	}
	r, err := b.AwaitTranscript(context.Background(), ListenRequest{Timeout: 5 * time.Second})
	if err != nil || r.Text != "synthetic question" || r.NativeID != "17" {
		t.Fatal(r, err)
	}
	reply = "Nothing heard in 5 s."
	r, err = b.AwaitTranscript(context.Background(), ListenRequest{Timeout: 5 * time.Second})
	if !errors.Is(err, ErrNoTranscript) || r.Text != "" {
		t.Fatal(r, err)
	}
	reply = "Changed protocol text"
	if _, err = b.AwaitTranscript(context.Background(), ListenRequest{Timeout: 5 * time.Second}); !errors.Is(err, ErrProtocol) {
		t.Fatal("unrecognized reply became transcript", err)
	}
}

func TestAdaptersBoundNativeRepliesAndKeepMissingCapabilitiesExplicit(t *testing.T) {
	b := NewPiper(func(context.Context, string, string, []byte, time.Duration) ([]byte, error) {
		return make([]byte, MaxControlReply+1), nil
	})
	if _, err := b.Speak(context.Background(), SpeechRequest{Text: "synthetic"}); !errors.Is(err, ErrProtocol) {
		t.Fatal(err)
	}
	if _, err := b.AwaitTranscript(context.Background(), ListenRequest{}); !errors.Is(err, ErrUnsupported) {
		t.Fatal(err)
	}
	d := NewDeltaMCP(func(context.Context, string, map[string]any) (ToolReply, error) {
		t.Fatal("missing tool invoked")
		return ToolReply{}, nil
	}, DeltaCatalog{Tools: []string{"window"}})
	if d.Capabilities().Speak || d.Capabilities().TranscriptWait {
		t.Fatal(d.Capabilities())
	}
	if _, err := d.Speak(context.Background(), SpeechRequest{Text: "synthetic"}); !errors.Is(err, ErrUnsupported) {
		t.Fatal(err)
	}
}

func rate(v float64) *float64 { return &v }
