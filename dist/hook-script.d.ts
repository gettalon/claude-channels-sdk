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
export {};
//# sourceMappingURL=hook-script.d.ts.map