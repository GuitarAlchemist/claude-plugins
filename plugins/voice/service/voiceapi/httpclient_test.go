package voiceapi

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

type fixtureTransport func(*http.Request) (*http.Response, error)

func (f fixtureTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func fixtureReply(status int, body string) *http.Response {
	return &http.Response{StatusCode: status, Status: http.StatusText(status), Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body)), ContentLength: int64(len(body))}
}

func TestExtractedControlClientRefusesRedirectsAndKeepsOwnerPolicy(t *testing.T) {
	calls := 0
	ownerChecks := 0
	owner := &http.Client{Transport: fixtureTransport(func(r *http.Request) (*http.Response, error) {
		calls++
		v := fixtureReply(307, "")
		v.Header.Set("Location", "https://external.example.invalid/no")
		return v, nil
	}), CheckRedirect: func(*http.Request, []*http.Request) error { ownerChecks++; return nil }}
	c := ControlClient{Address: "127.0.0.1:59126", Client: owner}
	if _, err := c.Do(context.Background(), "POST", "/v1/say", []byte(`{"text":"synthetic"}`), time.Second); err == nil {
		t.Fatal("redirect accepted")
	}
	if calls != 1 || ownerChecks != 0 {
		t.Fatal("redirect followed", calls, ownerChecks)
	}
	_ = owner.CheckRedirect(nil, nil)
	if ownerChecks != 1 {
		t.Fatal("owner client was mutated")
	}
}

func TestExtractedControlClientBoundsBodyAndPreservesCancellation(t *testing.T) {
	owner := &http.Client{Transport: fixtureTransport(func(r *http.Request) (*http.Response, error) {
		if r.URL.Path == "/slow" {
			<-r.Context().Done()
			return nil, r.Context().Err()
		}
		return fixtureReply(200, strings.Repeat("x", MaxControlReply+1)), nil
	})}
	c := ControlClient{Address: "127.0.0.1:59126", Client: owner}
	if _, err := c.Do(context.Background(), "GET", "/large", nil, time.Second); !errors.Is(err, ErrProtocol) {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()
	if _, err := c.Do(ctx, "GET", "/slow", nil, time.Second); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal(err)
	}
}

func TestControlAddressAndPathCannotEscapeLoopback(t *testing.T) {
	called := false
	owner := &http.Client{Transport: fixtureTransport(func(*http.Request) (*http.Response, error) { called = true; return fixtureReply(200, "{}"), nil })}
	for _, addr := range []string{"external.example.invalid:80", "127.0.0.1:80@external.example.invalid", "localhost:80@external.example.invalid", "localhost:http", "127.0.0.1:65536"} {
		if _, err := (ControlClient{Address: addr, Client: owner}).Do(context.Background(), "GET", "/health", nil, time.Second); err == nil {
			t.Fatal(addr)
		}
	}
	for _, path := range []string{"@external.example.invalid/", "//external.example.invalid/", `\external\path`, "/bad\r\nHeader: x"} {
		if _, err := (ControlClient{Address: "127.0.0.1:59126", Client: owner}).Do(context.Background(), "GET", path, nil, time.Second); err == nil {
			t.Fatal(path)
		}
	}
	if called {
		t.Fatal("unsafe operation reached transport")
	}
}
