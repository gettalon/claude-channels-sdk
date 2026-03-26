# @gettalon/channels-sdk

SDK for building [Claude Code channels](https://docs.anthropic.com/en/docs/claude-code) with bidirectional chat, permission relay, and all 23 hook events.

Use this to connect any client (browser extension, mobile app, Slack bot, Discord bot, etc.) to a live Claude Code session.

## Install

```bash
npm install @gettalon/channels-sdk
```

After install, run setup to configure Claude Code:

```bash
claude-channels setup
```

This will:
- Add your channel as an MCP server in Claude Code settings
- Install hook commands for selected events (with presets: minimal, chat, monitor, permissions, all)

You can also run non-interactively:

```bash
claude-channels setup --name my-channel --entry ./server.js --preset all
claude-channels setup --name my-channel --entry ./server.js --hooks PreToolUse,PostToolUse
claude-channels remove   # clean up settings
```

## Quick Start

```typescript
import { ChannelServer } from "@gettalon/channels-sdk";

const channel = new ChannelServer({
  name: "my-channel",
  version: "1.0.0",
  instructions:
    'Messages arrive as <channel source="my-channel" chat_id="..." user="...">. ' +
    "Reply with the reply tool, passing chat_id back.",
});

// Forward hook events to your client
channel.onHookEvent((input) => {
  console.log(input.hook_event_name, input);
});

// Handle permission requests from Claude
channel.onPermissionRequest((request) => {
  // Show UI, then:
  channel.sendPermissionVerdict({
    request_id: request.request_id,
    behavior: "allow",
  });
});

// Handle Claude's replies
channel.onReply((chatId, text) => {
  // Send text to your client
});

// Push messages from your client into Claude's session
channel.pushMessage("Hello from the browser!", {
  chat_id: "abc123",
  user: "browser",
});

await channel.start();
```

## MCP Config

Add to `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "my-channel": {
      "command": "node",
      "args": ["./my-server.js"]
    }
  }
}
```

## Hook Events

Forward Claude Code lifecycle events to your client by adding command hooks. The SDK includes a `claude-hook` binary that pipes events through a Unix socket to your ChannelServer.

### Manual Setup

```json
{
  "hooks": {
    "PreToolUse": [{ "type": "command", "command": "claude-hook --socket ~/.claude/channel-hooks.sock" }],
    "PostToolUse": [{ "type": "command", "command": "claude-hook --socket ~/.claude/channel-hooks.sock" }],
    "Notification": [{ "type": "command", "command": "claude-hook --socket ~/.claude/channel-hooks.sock" }]
  }
}
```

### Programmatic Setup

```typescript
const config = channel.generateHooksConfig("claude-hook");
// Returns a complete hooks config for all 23 events
```

### All 23 Hook Events

| Event | Blocking | Description |
|-------|----------|-------------|
| `SessionStart` | No | Session started or resumed |
| `SessionEnd` | No | Session ended |
| `UserPromptSubmit` | Yes | User submitted a prompt |
| `PreToolUse` | Yes | Before a tool executes |
| `PostToolUse` | No | After a tool executes |
| `PostToolUseFailure` | No | Tool execution failed |
| `PermissionRequest` | Yes | Tool needs permission |
| `Notification` | No | System notification |
| `SubagentStart` | No | Subagent spawned |
| `SubagentStop` | Yes | Subagent finished |
| `Stop` | Yes | Claude wants to stop |
| `StopFailure` | No | Stop hook failed |
| `TeammateIdle` | Yes | Teammate is idle |
| `TaskCompleted` | Yes | Task completed |
| `InstructionsLoaded` | No | Instructions file loaded |
| `ConfigChange` | Yes | Config file changed |
| `CwdChanged` | No | Working directory changed |
| `FileChanged` | No | File changed on disk |
| `WorktreeCreate` | Yes | Git worktree created |
| `WorktreeRemove` | No | Git worktree removed |
| `PreCompact` | No | Before context compaction |
| `PostCompact` | No | After context compaction |
| `Elicitation` | Yes | MCP elicitation dialog |
| `ElicitationResult` | Yes | Elicitation result submitted |

Blocking events can return a response that controls Claude's behavior (allow/deny tools, inject system messages, stop the session, etc.).

## Permission Relay

When `permissionRelay: true` (default), Claude Code forwards tool permission prompts to your channel. Your client can approve or deny them remotely:

```typescript
channel.onPermissionRequest((request) => {
  // request.tool_name, request.description, request.input_preview
  // Show to user, then:
  channel.sendPermissionVerdict({
    request_id: request.request_id,
    behavior: "allow", // or "deny"
  });
});
```

## Extra Tools

Register additional MCP tools that Claude can call:

```typescript
const channel = new ChannelServer({
  name: "my-channel",
  version: "1.0.0",
  instructions: "...",
  extraTools: [
    {
      name: "search",
      description: "Search the web",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
        },
        required: ["query"],
      },
    },
  ],
});

channel.onToolCall(async (name, args) => {
  if (name === "search") {
    return await mySearchFunction(args.query as string);
  }
  throw new Error(`Unknown tool: ${name}`);
});
```

## API

### `new ChannelServer(options)`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `name` | `string` | required | MCP server name |
| `version` | `string` | required | Server version |
| `instructions` | `string` | required | Instructions for Claude's system prompt |
| `permissionRelay` | `boolean` | `true` | Enable permission relay |
| `socketPath` | `string` | `~/.claude/channel-hooks.sock` | Unix socket path for hook IPC |
| `extraTools` | `Array` | `[]` | Additional MCP tools |
| `enabledHooks` | `HookEventName[]` | all | Which hooks to accept |
| `blockingTimeout` | `number` | `30000` | Timeout for blocking hook responses (ms) |

### Methods

- `start()` — Start IPC socket and connect MCP over stdio
- `pushMessage(content, meta?)` — Push a message into Claude's session
- `sendPermissionVerdict(verdict)` — Allow or deny a permission request
- `resolveHook(id, response)` — Respond to a blocking hook event
- `getSocketPath()` — Get the Unix socket path
- `generateHooksConfig(scriptPath)` — Generate settings.json hooks config
- `cleanup()` — Clean up socket file on shutdown

### Event Handlers

- `onHookEvent(handler)` — All hook events
- `onPermissionRequest(handler)` — Permission relay requests
- `onReply(handler)` — Claude's reply tool calls
- `onToolCall(handler)` — Extra tool calls

## Requirements

- Node.js >= 18
- Claude Code with channel support

## License

MIT
