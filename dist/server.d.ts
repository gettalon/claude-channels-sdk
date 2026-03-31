#!/usr/bin/env node
/**
 * Talon Channels — Universal MCP Server
 *
 * Direct-start binary that runs as an MCP server with multiple transports:
 *
 *   Transport (TALON_TRANSPORT):
 *     "stdio"     — MCP over stdin/stdout (default, for Claude Code)
 *     "ws"        — WebSocket + HTTP server with all channel features
 *     "http"      — MCP-over-HTTP (SSE) server
 *     "platform"  — Platform adapter (Telegram, Discord, Slack, etc.)
 *
 *   Mode (WS_MODE, for ws transport):
 *     "both"   — server + client (default)
 *     "server" — listen only
 *     "client" — connect to remote only
 *
 *   Group (WS_GROUP_NAME):
 *     access: public | private | invite
 *     maxMembers: WS_GROUP_MAX_MEMBERS
 *
 *   Mesh (MESH_SECRET):
 *     mDNS discovery, JWT auth, E2E encryption
 *
 * Usage:
 *   channels                           # stdio MCP (default)
 *   TALON_TRANSPORT=ws channels        # WebSocket + HTTP
 *   TALON_TRANSPORT=http channels      # HTTP/SSE
 *   TALON_CHANNEL=telegram channels    # Telegram adapter
 */
export {};
//# sourceMappingURL=server.d.ts.map