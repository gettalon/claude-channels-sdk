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

import { ChannelServer } from "./channel-server.js";
import { HubConfigService } from "./hub-config-service.js";
import type {
  HookEventInput,
  HookEventName,
  ChannelPermissionRequest,
} from "./types.js";

// ─── Transport Selection ─────────────────────────────────────────────────────

const cfg = HubConfigService.fromEnv();
const transport = cfg.talonTransport();

// ─── Platform Channels ───────────────────────────────────────────────────────

const PLATFORM_CHANNELS = [
  "telegram", "discord", "slack", "whatsapp", "signal", "imessage",
  "irc", "googlechat", "line", "feishu", "matrix", "mattermost",
  "msteams", "bluebubbles", "nostr", "nextcloud-talk", "synology-chat",
  "tlon", "twitch", "zalo", "zalouser",
] as const;

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Platform adapter mode (TALON_CHANNEL=telegram, etc.)
  const platformChannel = cfg.talonChannel();
  if (platformChannel && PLATFORM_CHANNELS.includes(platformChannel as any)) {
    await startPlatformChannel(platformChannel);
    return;
  }

  switch (transport) {
    case "stdio":
      await startStdio();
      break;
    case "ws":
    case "websocket":
      await startWebSocket();
      break;
    case "http":
      await startHttp();
      break;
    default:
      // Check if transport is a platform name
      if (PLATFORM_CHANNELS.includes(transport as any)) {
        await startPlatformChannel(transport);
      } else {
        process.stderr.write(`[channels] Unknown transport: "${transport}". Use: stdio, ws, http, or a platform name.\n`);
        process.exit(1);
      }
  }
}

// ─── Stdio Transport (default MCP) ──────────────────────────────────────────

async function startStdio(): Promise<void> {
  const channel = new ChannelServer({
    name: "talon-channels",
    version: "1.2.0",
    instructions:
      'Messages arrive as <channel source="talon-channels" chat_id="..." user="...">. ' +
      "Reply with the reply tool, passing chat_id back.",
    permissionRelay: true,
  });

  await channel.start();
  process.stderr.write(`[channels] Ready (stdio MCP)\n`);

  const shutdown = () => { channel.cleanup(); process.exit(0); };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

// ─── WebSocket Transport (full-featured) ─────────────────────────────────────

async function startWebSocket(): Promise<void> {
  const { createWebSocketChannel } = await import("./channels/websocket.js");

  const groupName = cfg.wsGroupName();
  const groupAccess = cfg.wsGroupAccess();
  const maxMembers = cfg.wsGroupMaxMembers();
  const mode = cfg.wsMode();
  const port = cfg.wsPort();
  const meshSecret = cfg.meshSecret();

  const { channel, cleanup } = await createWebSocketChannel({
    mode: mode as "server" | "client" | "both",
    port: port,
    host: cfg.wsHost(),
    url: cfg.wsUrl(),
    agentName: cfg.wsAgentName(),
    pairToken: cfg.wsPairToken(),
    autoReconnect: cfg.wsAutoReconnect(),
    httpEnabled: cfg.wsHttpEnabled(),
    group: groupName ? { name: groupName, access: groupAccess, maxMembers: maxMembers || undefined } : undefined,
    mesh: meshSecret ? {
      meshSecret: meshSecret,
      deviceId: cfg.meshDeviceId(),
      agentName: cfg.wsAgentName(),
      port: port,
      mdns: cfg.meshMdns(),
      registryUrl: cfg.meshRegistryUrl(),
      e2e: cfg.meshE2e(),
    } : undefined,
  });

  await channel.start();

  const features = [
    `mode=${mode}`,
    `port=${port}`,
    groupName ? `group=${groupName}(${groupAccess})` : null,
    meshSecret ? "mesh" : null,
    cfg.meshE2e() ? "e2e" : null,
  ].filter(Boolean).join(", ");

  process.stderr.write(`[channels] Ready (ws+http+stdio MCP) [${features}]\n`);

  const shutdown = () => { cleanup(); process.exit(0); };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

// ─── HTTP Transport (MCP-over-HTTP with SSE) ─────────────────────────────────

async function startHttp(): Promise<void> {
  const { createMcpHttpChannel } = await import("./channels/mcp-http.js");
  const { channel, cleanup } = await createMcpHttpChannel();

  await channel.start();
  process.stderr.write(`[channels] Ready (http MCP)\n`);

  const shutdown = () => { cleanup(); process.exit(0); };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

// ─── Platform Channel (Telegram, Discord, Slack, etc.) ───────────────────────

async function startPlatformChannel(name: string): Promise<void> {
  process.stderr.write(`[channels] Starting platform: ${name}\n`);

  const mod = await import("./channels/index.js") as any;

  const creators: Record<string, (() => Promise<{ channel: ChannelServer; cleanup: () => void }>) | undefined> = {
    telegram: mod.createTelegramChannel,
    discord: mod.createDiscordChannel,
    slack: mod.createSlackChannel,
    whatsapp: mod.createWhatsAppChannel,
    signal: mod.createSignalChannel,
    imessage: mod.createIMessageChannel,
    irc: mod.createIrcChannel,
    googlechat: mod.createGoogleChatChannel,
    line: mod.createLineChannel,
    feishu: mod.createFeishuChannel,
    matrix: mod.createMatrixChannel,
    mattermost: mod.createMattermostChannel,
    msteams: mod.createMsTeamsChannel,
    bluebubbles: mod.createBlueBubblesChannel,
    nostr: mod.createNostrChannel,
    "nextcloud-talk": mod.createNextcloudTalkChannel,
    "synology-chat": mod.createSynologyChatChannel,
    tlon: mod.createTlonChannel,
    twitch: mod.createTwitchChannel,
    zalo: mod.createZaloChannel,
    zalouser: mod.createZaloUserChannel,
  };

  const create = creators[name];
  if (!create) {
    process.stderr.write(`[channels] Unknown platform: ${name}\n`);
    process.exit(1);
  }

  const { channel, cleanup } = await create();
  await channel.start();
  process.stderr.write(`[channels] Ready (${name})\n`);

  const shutdown = () => { cleanup(); process.exit(0); };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

// ─── Run ─────────────────────────────────────────────────────────────────────

main().catch((err) => {
  process.stderr.write(`[channels] Fatal: ${err}\n`);
  process.exit(1);
});
