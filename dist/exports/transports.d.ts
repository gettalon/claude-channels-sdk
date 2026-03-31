/**
 * Subpath entry: @gettalon/channels-sdk/transports
 *
 * All built-in transports and application-level channel adapters.
 */
export { UnixSocketAdapter, createUnixTransport, WebSocketAdapter, createWebSocketTransport, TelegramAdapter, createTelegramTransport, StdioAdapter, StdioTransport, createStdioTransport, } from "../transports/index.js";
export { createDiscordTransport, createSlackTransport, createWhatsAppTransport, createMatrixTransport, createSignalTransport, createIrcTransport, createLineTransport, createFeishuTransport, createMsTeamsTransport, createIMessageTransport, } from "../transports/index.js";
export type { Transport, TransportAdapter, ConnectionHandler, MessageHandler, } from "../protocol.js";
//# sourceMappingURL=transports.d.ts.map