package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// serviceClient talks to a running service; the CLI commands and the MCP tools use it.
type serviceClient struct{ addr string }

// do sends one request and returns the answer's body. An error status becomes an error that
// carries the service's {"error"} text; the body is returned with it.
func (c serviceClient) do(ctx context.Context, method, path string, body []byte, timeout time.Duration) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, method, "http://"+c.addr+path, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("the voice service is not answering on %s; start it with: piper-voice serve (%v)", c.addr, err)
	}
	defer resp.Body.Close()
	out, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode >= 400 {
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

// sayTimeout is how long a say request may take: queuing is quick, but with wait the answer
// comes once the text has been spoken.
func sayTimeout(wait bool) time.Duration {
	if wait {
		return 10 * time.Minute
	}
	return 10 * time.Second
}
