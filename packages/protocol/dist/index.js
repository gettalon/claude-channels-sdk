/**
 * @gettalon/protocol — Transport-Agnostic Message Types
 *
 * This protocol works over ANY transport:
 * - WebSocket (real-time, bidirectional)
 * - HTTP (request/response, polling, SSE)
 * - HTTP Upgrade → WebSocket (start HTTP, upgrade to WS)
 * - Bluetooth (BLE characteristics, serial)
 * - USB/Serial
 * - Unix socket
 * - stdio
 * - MQTT
 * - gRPC
 *
 * All messages are JSON. Each transport adapter serializes/deserializes
 * these types and handles connection lifecycle.
 */
// ── Message Type Enum ───────────────────────────────────────────────────────
// Built-in types + extensible via string union
export const MessageType = {
    // Connection lifecycle
    REGISTER: "register",
    REGISTER_ACK: "register_ack",
    HEARTBEAT: "heartbeat",
    HEARTBEAT_ACK: "heartbeat_ack",
    ACK: "ack",
    // Tool execution
    TOOL_CALL: "tool_call",
    TOOL_RESULT: "tool_result",
    // Messaging
    CHAT: "chat",
    REPLY: "reply",
    // Permissions
    PERMISSION_REQUEST: "permission_request",
    PERMISSION_VERDICT: "permission_verdict",
    // Files & groups
    FILE_TRANSFER: "file_transfer",
    GROUP_BROADCAST: "group_broadcast",
    GROUP_INFO: "group_info",
    INVITE: "invite",
    // Agent-initiated control
    RELEASE: "release",
    HANDOVER_REQUEST: "handover",
    // Streaming
    STREAM_START: "stream_start",
    STREAM_CHUNK: "stream_chunk",
    STREAM_END: "stream_end",
};
// ── Serialization ───────────────────────────────────────────────────────────
export function serialize(message) {
    return JSON.stringify(message);
}
export function deserialize(data) {
    return JSON.parse(data);
}
/** Serialize for binary transports (Bluetooth, USB) */
export function serializeBuffer(message) {
    return Buffer.from(JSON.stringify(message));
}
export function deserializeBuffer(data) {
    return JSON.parse(data.toString());
}
let _envelopeCounter = 0;
/** Create a SessionEnvelope wrapping a payload */
export function createEnvelope(from, type, payload, opts) {
    return {
        id: `env-${Date.now()}-${++_envelopeCounter}`,
        timestamp: Date.now(),
        from,
        to: opts?.to,
        type,
        payload,
        session: opts?.session,
    };
}
const channelRegistry = new Map();
/**
 * Register a channel adapter factory.
 * @param requireE2E - Whether connections over this transport require E2E encryption. Defaults to true.
 */
export function registerChannel(type, factory, { requireE2E = true } = {}) {
    channelRegistry.set(type, { factory, requireE2E });
}
/** Returns true if the transport requires E2E encryption (defaults to true for unknown transports). */
export function transportRequiresE2E(type) {
    return channelRegistry.get(type)?.requireE2E ?? true;
}
/** Create a channel adapter by type */
export function createChannel(type, config = {}) {
    const reg = channelRegistry.get(type);
    if (!reg) {
        throw new Error(`Unknown channel: ${type}. Registered: ${[...channelRegistry.keys()].join(", ")}`);
    }
    return reg.factory(config);
}
/** List registered channel types */
export function listChannels() {
    return [...channelRegistry.keys()];
}
/** @deprecated Use registerChannel */
export const registerTransport = registerChannel;
/** @deprecated Use createChannel */
export const createTransport = createChannel;
/** @deprecated Use listChannels */
export const listTransports = listChannels;
const messageTypeRegistry = new Map();
/** Register a custom message type handler */
export function registerMessageType(type, handler) {
    messageTypeRegistry.set(type, handler);
}
/** Get handler for a message type */
export function getMessageHandler(type) {
    return messageTypeRegistry.get(type);
}
/** List registered custom message types */
export function listMessageTypes() {
    return [...messageTypeRegistry.keys()];
}
//# sourceMappingURL=index.js.map