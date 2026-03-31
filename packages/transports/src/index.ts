/**
 * @gettalon/transports — built-in transport adapters
 *
 * Exports unix, websocket, stdio, and telegram transports.
 * Automatically registers them with the protocol channel registry on import.
 */
import { registerChannel } from "@gettalon/protocol";
import { createUnixTransport, UnixSocketAdapter } from "./unix.js";
import { createWebSocketTransport, WebSocketAdapter } from "./websocket.js";
import { createTelegramTransport, TelegramAdapter } from "./telegram.js";
import { createStdioTransport, StdioAdapter, StdioTransport } from "./stdio.js";

// Local transports — always trusted, no E2E needed
registerChannel("unix", createUnixTransport, { requireE2E: false });
registerChannel("stdio", createStdioTransport, { requireE2E: false });

// Remote hub-to-hub transport — E2E required (default)
registerChannel("websocket", createWebSocketTransport);

// Telegram transport — messages go via platform, no E2E
registerChannel("telegram", createTelegramTransport, { requireE2E: false });

export { UnixSocketAdapter, createUnixTransport } from "./unix.js";
export { WebSocketAdapter, createWebSocketTransport } from "./websocket.js";
export { TelegramAdapter, createTelegramTransport } from "./telegram.js";
export { StdioAdapter, StdioTransport, createStdioTransport } from "./stdio.js";
