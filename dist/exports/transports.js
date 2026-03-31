/**
 * Subpath entry: @gettalon/channels-sdk/transports
 *
 * All built-in transports and application-level channel adapters.
 */
// Built-in transports
export { UnixSocketAdapter, createUnixTransport, WebSocketAdapter, createWebSocketTransport, TelegramAdapter, createTelegramTransport, StdioAdapter, StdioTransport, createStdioTransport, } from "../transports/index.js";
// Application-level channel adapters
export { createDiscordTransport, createSlackTransport, createWhatsAppTransport, createMatrixTransport, createSignalTransport, createIrcTransport, createLineTransport, createFeishuTransport, createMsTeamsTransport, createIMessageTransport, } from "../transports/index.js";
//# sourceMappingURL=transports.js.map