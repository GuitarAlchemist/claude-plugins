package main

import (
	"context"
	"time"

	"github.com/GuitarAlchemist/claude-plugins/plugins/voice/service/voiceapi"
)

// serviceClient talks to a running service; the CLI commands and the MCP tools use it.
type serviceClient struct{ addr string }

// do sends one request and returns the answer's body. An error status becomes an error that
// carries the service's {"error"} text; the body is returned with it.
func (c serviceClient) do(ctx context.Context, method, path string, body []byte, timeout time.Duration) ([]byte, error) {
	return (voiceapi.ControlClient{Address: c.addr}).Do(ctx, method, path, body, timeout)
}

// sayTimeout is how long a say request may take: queuing is quick, but with wait the answer
// comes once the text has been spoken.
func sayTimeout(wait bool) time.Duration {
	return voiceapi.SpeechTimeout(wait)
}
