package voiceapi

import (
	"context"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// BindDeltaSession only reads the catalog of an already connected, caller-owned
// session. It never starts/closes a process, transport, microphone or session.
func BindDeltaSession(ctx context.Context, session *mcp.ClientSession) (*Delta, error) {
	if session == nil {
		return nil, ErrUnavailable
	}
	initialized := session.InitializeResult()
	if initialized == nil || initialized.ServerInfo == nil || initialized.ServerInfo.Name != "delta" || len(initialized.ServerInfo.Version) > 128 {
		return nil, ErrProtocol
	}
	catalog, err := session.ListTools(ctx, nil)
	if err != nil {
		return nil, err
	}
	if catalog == nil || catalog.NextCursor != "" || len(catalog.Tools) > 64 {
		return nil, ErrProtocol
	}
	tools := make([]string, 0, len(catalog.Tools))
	for _, tool := range catalog.Tools {
		if tool == nil || len(tool.Name) > 128 {
			return nil, ErrProtocol
		}
		tools = append(tools, tool.Name)
	}
	invoke := func(ctx context.Context, name string, args map[string]any) (ToolReply, error) {
		r, err := session.CallTool(ctx, &mcp.CallToolParams{Name: name, Arguments: args})
		if err != nil {
			return ToolReply{}, err
		}
		if r == nil || len(r.Content) > 8 {
			return ToolReply{}, ErrProtocol
		}
		reply := ToolReply{IsError: r.IsError}
		total := 0
		for _, item := range r.Content {
			text, ok := item.(*mcp.TextContent)
			if !ok || text == nil {
				return ToolReply{}, ErrProtocol
			}
			total += len(text.Text)
			if total > MaxControlReply {
				return ToolReply{}, ErrProtocol
			}
			reply.Text = append(reply.Text, text.Text)
		}
		return reply, nil
	}
	return NewDeltaMCP(invoke, DeltaCatalog{Version: initialized.ServerInfo.Version, Tools: tools}), nil
}
