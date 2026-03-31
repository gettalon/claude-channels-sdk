/**
 * Edge Agent Protocol — Transport-Agnostic Message Types
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
/**
 * Discover Talon servers.
 * - local: scan common ports on localhost + LAN
 * - mdns: multicast DNS (if available)
 * - relay: query a relay registry URL
 */
export async function discover(opts = {}) {
    const source = opts.source ?? "all";
    const timeout = opts.timeout ?? 3000;
    const results = [];
    if (source === "local" || source === "all") {
        results.push(...await discoverLocal(opts.ports ?? [9090, 8080, 3000, 8788], timeout));
    }
    if (source === "mdns" || source === "all") {
        results.push(...await discoverMdns(timeout));
    }
    if ((source === "relay" || source === "all") && opts.relayUrl) {
        results.push(...await discoverRelay(opts.relayUrl, timeout));
    }
    return results;
}
async function discoverLocal(ports, timeout) {
    const found = [];
    // Check localhost
    for (const port of ports) {
        try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeout);
            const res = await fetch(`http://localhost:${port}/health`, { signal: controller.signal });
            clearTimeout(timer);
            if (res.ok) {
                const data = await res.json().catch(() => ({}));
                found.push({
                    url: `ws://localhost:${port}`,
                    name: data.name ?? `localhost:${port}`,
                    agents: data.agents,
                    source: "local",
                    metadata: data,
                });
            }
        }
        catch {
            // Not listening on this port
        }
    }
    // Check LAN peers via common subnets
    // (lightweight: only check gateway and a few common IPs)
    try {
        const { networkInterfaces } = await import("os");
        const nets = networkInterfaces();
        for (const iface of Object.values(nets)) {
            for (const net of iface ?? []) {
                if (net.family === "IPv4" && !net.internal) {
                    const parts = net.address.split(".");
                    const subnet = `${parts[0]}.${parts[1]}.${parts[2]}`;
                    // Check gateway (.1) and broadcast range (.2-.10) for quick scan
                    for (const host of [1, 2, 3, 4, 5]) {
                        const ip = `${subnet}.${host}`;
                        if (ip === net.address)
                            continue;
                        for (const port of ports.slice(0, 2)) { // only first 2 ports for LAN
                            try {
                                const controller = new AbortController();
                                const timer = setTimeout(() => controller.abort(), Math.min(timeout, 1000));
                                const res = await fetch(`http://${ip}:${port}/health`, { signal: controller.signal });
                                clearTimeout(timer);
                                if (res.ok) {
                                    const data = await res.json().catch(() => ({}));
                                    found.push({
                                        url: `ws://${ip}:${port}`,
                                        name: data.name ?? `${ip}:${port}`,
                                        agents: data.agents,
                                        source: "local",
                                        metadata: data,
                                    });
                                }
                            }
                            catch { }
                        }
                    }
                }
            }
        }
    }
    catch { }
    return found;
}
async function discoverMdns(timeout) {
    // mDNS discovery — uses the mesh module if available
    try {
        const { MeshDiscovery } = await import("./mesh.js");
        const discovery = new MeshDiscovery({ meshSecret: "", agentName: "discover", port: 0 });
        const found = [];
        discovery.on("peerDiscovered", (peer) => {
            found.push({
                url: `ws://${peer.host ?? peer.ip}:${peer.port}`,
                name: peer.name ?? peer.id,
                source: "mdns",
                metadata: peer,
            });
        });
        await discovery.start();
        await new Promise((r) => setTimeout(r, timeout));
        discovery.stop();
        return found;
    }
    catch {
        return []; // mDNS not available
    }
}
async function discoverRelay(relayUrl, timeout) {
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);
        const res = await fetch(`${relayUrl}/peers`, { signal: controller.signal });
        clearTimeout(timer);
        if (!res.ok)
            return [];
        const peers = await res.json();
        return peers.map((p) => ({
            url: p.url ?? `ws://${p.ip ?? p.host}:${p.port}`,
            name: p.name ?? p.id,
            agents: p.agents,
            source: "relay",
            metadata: p,
        }));
    }
    catch {
        return [];
    }
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
//# sourceMappingURL=protocol.js.map