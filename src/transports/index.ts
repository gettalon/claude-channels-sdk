/**
 * Built-in Transports — auto-registered on import
 *
 * The SDK ships with unix, websocket, stdio, and telegram transports,
 * plus application-level channel adapters (discord, slack, whatsapp, etc.)
 * wrapped as transport adapters.
 *
 * Agents can register custom ones (bluetooth, mqtt, grpc, etc.)
 * via registerTransport() from protocol.ts.
 */
import { registerChannel } from "../protocol.js";
import { createUnixTransport, UnixSocketAdapter } from "./unix.js";
import { createWebSocketTransport, WebSocketAdapter } from "./websocket.js";
import { createTelegramTransport, TelegramAdapter } from "./telegram.js";
import { createStdioTransport, StdioAdapter } from "./stdio.js";
import {
  createDiscordTransport,
  createSlackTransport,
  createWhatsAppTransport,
  createMatrixTransport,
  createSignalTransport,
  createIrcTransport,
  createLineTransport,
  createFeishuTransport,
  createMsTeamsTransport,
  createIMessageTransport,
} from "./app-channels.js";

// Local transports — always trusted, no E2E needed
registerChannel("unix", createUnixTransport, { requireE2E: false });
registerChannel("stdio", createStdioTransport, { requireE2E: false });

// Remote hub-to-hub transport — E2E required (default)
registerChannel("websocket", createWebSocketTransport);

// Application-level channel adapters — messages go via platform, no E2E
registerChannel("telegram", createTelegramTransport, { requireE2E: false });
registerChannel("discord", createDiscordTransport, { requireE2E: false });
registerChannel("slack", createSlackTransport, { requireE2E: false });
registerChannel("whatsapp", createWhatsAppTransport, { requireE2E: false });
registerChannel("matrix", createMatrixTransport, { requireE2E: false });
registerChannel("signal", createSignalTransport, { requireE2E: false });
registerChannel("irc", createIrcTransport, { requireE2E: false });
registerChannel("line", createLineTransport, { requireE2E: false });
registerChannel("feishu", createFeishuTransport, { requireE2E: false });
registerChannel("msteams", createMsTeamsTransport, { requireE2E: false });
registerChannel("imessage", createIMessageTransport, { requireE2E: false });

export { UnixSocketAdapter, createUnixTransport } from "./unix.js";
export { WebSocketAdapter, createWebSocketTransport } from "./websocket.js";
export { TelegramAdapter, createTelegramTransport } from "./telegram.js";
export { StdioAdapter, StdioTransport, createStdioTransport } from "./stdio.js";

// Application-level channel adapters as transports
export {
  createDiscordTransport,
  createSlackTransport,
  createWhatsAppTransport,
  createMatrixTransport,
  createSignalTransport,
  createIrcTransport,
  createLineTransport,
  createFeishuTransport,
  createMsTeamsTransport,
  createIMessageTransport,
} from "./app-channels.js";
