#!/usr/bin/env node
/**
 * Talon CLI — Universal channel bridge for any CLI tool.
 *
 * Wraps CLI tools (codex, claude, gemini, etc.) with full channel support:
 * Telegram, WebSocket, agent-to-agent — without the tool needing to know.
 *
 * Architecture:
 *   ┌──────────┐      stdin       ┌──────────────┐     channels     ┌──────────┐
 *   │  child    │ ◄──────────────► │  ChannelHub  │ ◄──────────────► │ Telegram │
 *   │ (codex,   │   stdout        │  (in-proc)   │                  │ WS, etc. │
 *   │  claude…) │                 └──────────────┘                  └──────────┘
 *   └──────────┘
 *
 * Usage:
 *   talon codex [prompt]         — Run OpenAI Codex CLI with channels
 *   talon claude [prompt]        — Run Claude Code CLI with channels
 *   talon gemini [prompt]        — Run Gemini CLI with channels
 *   talon <any-cli> [args...]    — Run any CLI tool with channels
 *
 * Environment:
 *   TALON_PORT       — Hub server port (default: 9090)
 *   TALON_NO_SERVER  — Skip starting the hub server (connect-only mode)
 *   TALON_AGENT_NAME — Name for this agent in the hub
 */
export {};
//# sourceMappingURL=cli.d.ts.map