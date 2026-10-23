package main

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type mcpSayArgs struct {
	Text  string   `json:"text" jsonschema:"what to say aloud: one to three sentences in the user's language, never code, paths, URLs or secrets"`
	Voice string   `json:"voice,omitempty" jsonschema:"a voice id from the voices tool; the service's default when left out"`
	Rate  *float64 `json:"rate,omitempty" jsonschema:"speed from 0.5 to 2, where 1 is the voice's own"`
	Wait  bool     `json:"wait,omitempty" jsonschema:"answer only once the text has been spoken"`
}

type mcpNoArgs struct{}

// newMCPServer exposes a running service to an MCP client over the HTTP contract: each tool
// is one request to the service at addr, and its JSON answer is the tool's text.
func newMCPServer(addr string) *mcp.Server {
	s := mcp.NewServer(&mcp.Implementation{Name: "piper-voice", Version: version}, nil)
	c := serviceClient{addr: addr}
	call := func(ctx context.Context, method, path string, body []byte, timeout time.Duration) (*mcp.CallToolResult, any, error) {
		out, err := c.do(ctx, method, path, body, timeout)
		if err != nil {
			return nil, nil, err
		}
		return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: string(out)}}}, nil, nil
	}
	mcp.AddTool(s, &mcp.Tool{Name: "say", Description: "Speak a short text aloud on the user's speakers, sentence by sentence. " +
		"Only once the user has asked for voice; whatever is said aloud also goes in the written answer."},
		func(ctx context.Context, _ *mcp.CallToolRequest, a mcpSayArgs) (*mcp.CallToolResult, any, error) {
			body, err := json.Marshal(sayRequest{Text: a.Text, Voice: a.Voice, Rate: a.Rate, Wait: a.Wait})
			if err != nil {
				return nil, nil, err
			}
			return call(ctx, http.MethodPost, "/v1/say", body, sayTimeout(a.Wait))
		})
	mcp.AddTool(s, &mcp.Tool{Name: "stop", Description: "Stop speaking now: cut the current sentence and drop what is queued."},
		func(ctx context.Context, _ *mcp.CallToolRequest, _ mcpNoArgs) (*mcp.CallToolResult, any, error) {
			return call(ctx, http.MethodPost, "/v1/stop", nil, 5*time.Second)
		})
	mcp.AddTool(s, &mcp.Tool{Name: "voices", Description: "List the installed voices, with their language and licence."},
		func(ctx context.Context, _ *mcp.CallToolRequest, _ mcpNoArgs) (*mcp.CallToolResult, any, error) {
			return call(ctx, http.MethodGet, "/v1/voices", nil, 5*time.Second)
		})
	mcp.AddTool(s, &mcp.Tool{Name: "status", Description: "Whether the voice service is running, with its default voice."},
		func(ctx context.Context, _ *mcp.CallToolRequest, _ mcpNoArgs) (*mcp.CallToolResult, any, error) {
			return call(ctx, http.MethodGet, "/health", nil, 5*time.Second)
		})
	return s
}

func mcpCmd() error {
	return newMCPServer(envOr("PIPER_VOICE_ADDR", defaultAddr)).Run(context.Background(), &mcp.StdioTransport{})
}
