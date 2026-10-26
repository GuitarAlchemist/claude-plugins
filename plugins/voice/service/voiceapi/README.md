# Existing voice control adapters

This package aligns control interfaces while the existing backends coexist.
It owns no speech engine, audio scheduler, capture device, subprocess, connection
or UI. Piper/Whisper/Delta implementations remain where they already are.

```go
type Backend interface {
    Capabilities() Capabilities
    Speak(context.Context, SpeechRequest) (SpeechReceipt, error)
    AwaitTranscript(context.Context, ListenRequest) (Transcript, error)
    StopOutput(context.Context, StopRequest) (StopReceipt, error)
}
```

The existing voice MCP server now uses the Piper adapter for say/stop. Its four
tool names and native JSON receipts remain unchanged. The original HTTP control
client was extracted into ControlClient; the CLI and MCP delegate to it rather
than maintain another HTTP implementation.

| Contract | Piper HTTP | Delta v0.6-style MCP |
|---|---|---|
| Speak | Admission; optional native completion wait | Admission only; never implies playback finished |
| Selection | Native voice ID and rate | Native language and answered utterance ID |
| AwaitTranscript | Unsupported; existing frontend listener stays separate | Existing listen tool, strict characterized reply dialect |
| Capture control | Not owned | Not owned; cancelled listen is only a cancelled wait |
| StopOutput(service) | Requires explicit acknowledged=true and nonzero generation | Unsupported in this adapter; no guessed stop tool or process kill |
| StopOutput(request) | Unsupported; native service stop affects all output | Unsupported |
| Acoustic duplex/AEC | Unverified | Unverified |

Unsupported options return ErrUnsupported before native invocation. They are
never silently discarded. Caller RequestID is distinct from AnswerTo, which
identifies the native utterance being answered. Native receipt bytes are copied
and excluded from generic JSON serialization; adapters do not log transcripts.

## Bind to existing owners

Piper: `NewPiperHTTP("127.0.0.1:59126", callerHTTPClient)` connects only when an
operation is explicitly invoked. Alternatively NewPiper accepts the existing
control client's function. ControlClient rejects external addresses, URL/port
injection, redirects and control replies over1MiB, and preserves cancellation.
It does not mutate the caller's HTTP client or start the service.

Delta: `BindDeltaSession(ctx, alreadyConnectedSession)` reads the tool catalog
through the existing Go MCP SDK. It neither connects/closes the session nor
starts brain.exe or capture. The caller must own that session. NewDeltaMCP is
also available for an existing host's MCP invoker and catalog. Binding checks
the server name, bounds catalog/reply metadata and refuses unknown reply forms.

The Delta parser is based on characterized source: say accepts utterance_id as
string or number; listen timeout_seconds is numeric, including fractional.
Known transcript replies carry an utterance number; timeout is ErrNoTranscript.
An unrecognized native message is ErrProtocol, not an invented transcript.
Compatibility with a different Delta build must be characterized separately.

Requests admit at most20,000 valid Unicode code points. Caller identities and
selection strings are bounded. Listen waits are5..300seconds, default60, also
limited by caller context. Native invokers must honor context; the adapters do
not spawn goroutines to disguise an unresponsive injected host. The provided
HTTP/SDK paths have cancellation tests. A native stop acknowledgement concerns
service-side output purge, not samples already played by hardware.

## Verification and scope

Shared conformance tests exercise both adapters with in-memory native calls.
SDK tests use a simulated MCP peer and preserve the caller's session after a
cancelled wait. No microphone, model, real Delta process or provider API runs.
Existing Delta source characterization is separate from that simulation.

This is not a media transport. No WebRTC/signaling/ICE/AEC capability follows
from the common interface. The Indigo caller/configuration and exact Delta Live
build route remain unverified; this package does not claim an Indigo adapter.
