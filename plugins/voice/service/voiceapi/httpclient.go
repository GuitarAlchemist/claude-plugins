package voiceapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// ControlClient is extracted from the existing serviceClient, shared by the
// CLI/MCP and external adapters. Client is caller-owned and is never mutated.
type ControlClient struct {
	Address string
	Client  *http.Client
}

func ValidateLoopback(addr string) error {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return err
	}
	if ip := net.ParseIP(host); host == "localhost" || ip != nil && ip.IsLoopback() {
		return nil
	}
	return errors.New("the voice control target must be loopback: use 127.0.0.1:<port>")
}

func (c ControlClient) Do(ctx context.Context, method, path string, body []byte, timeout time.Duration) ([]byte, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if err := ValidateLoopback(c.Address); err != nil {
		return nil, err
	}
	_, port, _ := net.SplitHostPort(c.Address)
	p, err := strconv.Atoi(port)
	if err != nil || p < 1 || p > 65535 {
		return nil, ErrInvalidRequest
	}
	if timeout <= 0 || timeout > 10*time.Minute || len(body) > MaxControlReply {
		return nil, ErrInvalidRequest
	}
	if !strings.HasPrefix(path, "/") || strings.HasPrefix(path, "//") || strings.ContainsAny(path, "\\\r\n") {
		return nil, ErrInvalidRequest
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, method, "http://"+c.Address+path, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	if req.URL.User != nil || req.URL.Host != c.Address || req.URL.Scheme != "http" {
		return nil, ErrInvalidRequest
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	// Native control has no redirect contract. A copied client preserves its
	// transport/timeouts without changing its owner's policy or following a leak.
	client := http.Client{}
	if c.Client != nil {
		client = *c.Client
	}
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("the voice service is not answering on %s; start it with: piper-voice serve (%w)", c.Address, err)
	}
	defer resp.Body.Close()
	out, err := io.ReadAll(io.LimitReader(resp.Body, MaxControlReply+1))
	if err != nil {
		return nil, err
	}
	if len(out) > MaxControlReply {
		return nil, ErrProtocol
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		var e struct {
			Error string `json:"error"`
		}
		if json.Unmarshal(out, &e) == nil && e.Error != "" {
			return out, fmt.Errorf("the voice service refused (%d): %s", resp.StatusCode, e.Error)
		}
		return out, fmt.Errorf("the voice service answered %s", resp.Status)
	}
	return out, nil
}

func NewPiperHTTP(address string, client *http.Client) *Piper {
	return NewPiper(ControlClient{Address: address, Client: client}.Do)
}
