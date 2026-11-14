package main

import (
	"context"
	"encoding/json"
	"net"
	"os"
	"os/exec"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func mcpSession(t *testing.T, transport mcp.Transport) *mcp.ClientSession {
	t.Helper()
	ctx := context.Background()
	cs, err := mcp.NewClient(&mcp.Implementation{Name: "test", Version: "0"}, nil).Connect(ctx, transport, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cs.Close() })
	return cs
}

// inMemory connects a client to an MCP server that drives the service at addr.
func inMemory(t *testing.T, addr string) *mcp.ClientSession {
	t.Helper()
	st, ct := mcp.NewInMemoryTransports()
	ss, err := newMCPServer(addr).Connect(context.Background(), st, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ss.Close() })
	return mcpSession(t, ct)
}

func callTool(t *testing.T, cs *mcp.ClientSession, name string, args map[string]any) (string, bool) {
	t.Helper()
	res, err := cs.CallTool(context.Background(), &mcp.CallToolParams{Name: name, Arguments: args})
	if err != nil {
		t.Fatalf("%s: %v", name, err)
	}
	var text []string
	for _, c := range res.Content {
		if tc, ok := c.(*mcp.TextContent); ok {
			text = append(text, tc.Text)
		}
	}
	return strings.Join(text, "\n"), res.IsError
}

func TestMCPListsItsTools(t *testing.T) {
	ts, _ := testServer(t, 0)
	cs := inMemory(t, strings.TrimPrefix(ts.URL, "http://"))
	res, err := cs.ListTools(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, tool := range res.Tools {
		names = append(names, tool.Name)
		if tool.Name == "say" {
			schema, _ := json.Marshal(tool.InputSchema)
			if !strings.Contains(string(schema), `"required":["text"]`) {
				t.Errorf("say schema: %s", schema)
			}
		}
	}
	slices.Sort(names)
	if !slices.Equal(names, []string{"say", "status", "stop", "voices"}) {
		t.Fatalf("tools: %v", names)
	}
}

func TestMCPSayReachesTheService(t *testing.T) {
	ts, rec := testServer(t, 10*time.Millisecond)
	cs := inMemory(t, strings.TrimPrefix(ts.URL, "http://"))
	text, isErr := callTool(t, cs, "say", map[string]any{"text": "Bonjour.", "wait": true})
	if isErr || !strings.Contains(text, `"sentences":1`) || !strings.Contains(text, `"played_ms"`) {
		t.Fatalf("say: %v %s", isErr, text)
	}
	rec.index(t, "played Bonjour.")
	if text, isErr := callTool(t, cs, "voices", nil); isErr || !strings.Contains(text, testVoice.ID) {
		t.Fatalf("voices: %v %s", isErr, text)
	}
	if text, isErr := callTool(t, cs, "stop", nil); isErr || !strings.Contains(text, `"stopped"`) {
		t.Fatalf("stop: %v %s", isErr, text)
	}
}

func TestMCPToolErrorsCarryTheReason(t *testing.T) {
	ts, _ := testServer(t, 0)
	cs := inMemory(t, strings.TrimPrefix(ts.URL, "http://"))
	if text, isErr := callTool(t, cs, "say", map[string]any{"text": "x", "voice": "nope"}); !isErr || !strings.Contains(text, `no voice "nope"`) {
		t.Fatalf("refusal: %v %s", isErr, text)
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	closed := ln.Addr().String()
	ln.Close()
	down := inMemory(t, closed)
	if text, isErr := callTool(t, down, "status", nil); !isErr || !strings.Contains(text, "piper-voice serve") {
		t.Fatalf("service down: %v %s", isErr, text)
	}
}

// TestMCPOverStdio runs `piper-voice mcp` for real: the test binary re-executed (see TestMain).
func TestMCPOverStdio(t *testing.T) {
	ts, _ := testServer(t, 0)
	cmd := exec.Command(os.Args[0])
	cmd.Env = append(os.Environ(), "FAKE_MCP=1", "PIPER_VOICE_ADDR="+strings.TrimPrefix(ts.URL, "http://"))
	cs := mcpSession(t, &mcp.CommandTransport{Command: cmd})
	if text, isErr := callTool(t, cs, "status", nil); isErr || !strings.Contains(text, `"ok":true`) {
		t.Fatalf("status over stdio: %v %s", isErr, text)
	}
}
