#!/usr/bin/env node
/**
 * Claude Channels SDK — Hook Script
 *
 * This is the `type: "command"` script that Claude Code spawns for each hook event.
 * It reads JSON from stdin, forwards it to the ChannelServer via Unix socket,
 * optionally waits for a response, and writes the response JSON to stdout.
 *
 * Usage in settings.json:
 *   {
 *     "hooks": {
 *       "PreToolUse": [{
 *         "hooks": [{
 *           "type": "command",
 *           "command": "claude-hook --socket ~/.claude/channel-hooks.sock"
 *         }]
 *       }]
 *     }
 *   }
 */

import { connect } from "node:net";
import { BLOCKING_EVENTS, type HookEventInput, type HookIpcMessage, type HookIpcResponse } from "./types.js";

// ─── Parse args ──────────────────────────────────────────────────────────────

function parseArgs(): { socketPath: string } {
  const args = process.argv.slice(2);
  let socketPath = "";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--socket" && args[i + 1]) {
      socketPath = args[i + 1];
      i++;
    }
  }

  if (!socketPath) {
    const home = process.env.HOME ?? "/tmp";
    socketPath = `${home}/.claude/channel-hooks.sock`;
  }

  return { socketPath };
}

// ─── Read stdin ──────────────────────────────────────────────────────────────

async function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => { data += chunk; });
    process.stdin.on("end", () => resolve(data));
    // If stdin is a TTY or empty, resolve quickly
    if (process.stdin.isTTY) resolve("");
  });
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { socketPath } = parseArgs();

  // Read hook input from stdin
  const raw = await readStdin();
  if (!raw.trim()) {
    process.exit(0);
  }

  let input: HookEventInput;
  try {
    input = JSON.parse(raw);
  } catch {
    process.stderr.write(`[claude-hook] Invalid JSON from stdin\n`);
    process.exit(0);
  }

  const eventName = input.hook_event_name;
  const isBlocking = BLOCKING_EVENTS.has(eventName);
  const id = `${eventName}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // Connect to ChannelServer via Unix socket
  const socket = connect(socketPath);

  const timeout = setTimeout(() => {
    // Timeout — exit with 0 (allow) to not block Claude
    process.exit(0);
  }, isBlocking ? 55_000 : 8_000);

  socket.on("error", (err) => {
    // If ChannelServer isn't running, just let the hook pass through
    process.stderr.write(`[claude-hook] Cannot connect to ${socketPath}: ${err.message}\n`);
    clearTimeout(timeout);
    process.exit(0);
  });

  socket.on("connect", () => {
    // Send hook event
    const msg: HookIpcMessage = {
      type: "hook_event",
      id,
      input,
      blocking: isBlocking,
    };
    socket.write(JSON.stringify(msg) + "\n");

    if (!isBlocking) {
      // Non-blocking: don't wait for response
      clearTimeout(timeout);
      socket.end();
      process.exit(0);
    }
  });

  // Wait for response (blocking hooks only)
  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk.toString();
    const newlineIdx = buffer.indexOf("\n");
    if (newlineIdx === -1) return;

    const line = buffer.slice(0, newlineIdx).trim();
    if (!line) return;

    try {
      const resp: HookIpcResponse = JSON.parse(line);
      if (resp.id === id && resp.response) {
        clearTimeout(timeout);
        // Write response to stdout for Claude Code
        if (Object.keys(resp.response).length > 0) {
          process.stdout.write(JSON.stringify(resp.response));
        }
        socket.end();
        process.exit(0);
      }
    } catch {
      // ignore
    }
  });
}

main().catch((err) => {
  process.stderr.write(`[claude-hook] Fatal: ${err}\n`);
  process.exit(0); // exit 0 to not block Claude
});
