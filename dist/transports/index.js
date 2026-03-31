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
import { createUnixTransport } from "./unix.js";
import { createWebSocketTransport } from "./websocket.js";
import { createTelegramTransport } from "./telegram.js";
import { createStdioTransport } from "./stdio.js";
import { createDiscordTransport, createSlackTransport, createWhatsAppTransport, createMatrixTransport, createSignalTransport, createIrcTransport, createLineTransport, createFeishuTransport, createMsTeamsTransport, createIMessageTransport, } from "./app-channels.js";
// Auto-register built-in transports
registerChannel("unix", createUnixTransport);
registerChannel("websocket", createWebSocketTransport);
registerChannel("telegram", createTelegramTransport);
registerChannel("stdio", createStdioTransport);
// Auto-register application-level channel adapters as transports
registerChannel("discord", createDiscordTransport);
registerChannel("slack", createSlackTransport);
registerChannel("whatsapp", createWhatsAppTransport);
registerChannel("matrix", createMatrixTransport);
registerChannel("signal", createSignalTransport);
registerChannel("irc", createIrcTransport);
registerChannel("line", createLineTransport);
registerChannel("feishu", createFeishuTransport);
registerChannel("msteams", createMsTeamsTransport);
registerChannel("imessage", createIMessageTransport);
export { UnixSocketAdapter, createUnixTransport } from "./unix.js";
export { WebSocketAdapter, createWebSocketTransport } from "./websocket.js";
export { TelegramAdapter, createTelegramTransport } from "./telegram.js";
export { StdioAdapter, StdioTransport, createStdioTransport } from "./stdio.js";
// Application-level channel adapters as transports
export { createDiscordTransport, createSlackTransport, createWhatsAppTransport, createMatrixTransport, createSignalTransport, createIrcTransport, createLineTransport, createFeishuTransport, createMsTeamsTransport, createIMessageTransport, } from "./app-channels.js";
//# sourceMappingURL=index.js.map