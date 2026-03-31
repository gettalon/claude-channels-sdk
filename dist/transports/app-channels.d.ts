/**
 * Application-Level Channel Adapters as Transport Wrappers
 *
 * Wraps each application-level channel adapter (Discord, Slack, WhatsApp, etc.)
 * as a TransportAdapter so the edge agent can use them via:
 *   connect discord://<channel_id>
 *   connect slack://<channel_id>
 *   connect whatsapp://<jid>
 *   etc.
 *
 * Each wrapper:
 * - Uses the channel's ChannelServer for receiving messages (pushMessage -> onMessage)
 * - Sends messages via the channel's reply mechanism (send -> onReply)
 * - Registers as a channel type in the transport registry
 */
import type { TransportAdapter } from "../protocol.js";
export declare function createDiscordTransport(config?: Record<string, unknown>): TransportAdapter;
export declare function createSlackTransport(config?: Record<string, unknown>): TransportAdapter;
export declare function createWhatsAppTransport(config?: Record<string, unknown>): TransportAdapter;
export declare function createMatrixTransport(config?: Record<string, unknown>): TransportAdapter;
export declare function createSignalTransport(config?: Record<string, unknown>): TransportAdapter;
export declare function createIrcTransport(config?: Record<string, unknown>): TransportAdapter;
export declare function createLineTransport(config?: Record<string, unknown>): TransportAdapter;
export declare function createFeishuTransport(config?: Record<string, unknown>): TransportAdapter;
export declare function createMsTeamsTransport(config?: Record<string, unknown>): TransportAdapter;
export declare function createIMessageTransport(config?: Record<string, unknown>): TransportAdapter;
//# sourceMappingURL=app-channels.d.ts.map