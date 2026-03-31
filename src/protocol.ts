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
} as const;

/** Built-in message types + any custom string */
export type MessageTypeName = typeof MessageType[keyof typeof MessageType] | (string & {});

// ── Core Message Types ──────────────────────────────────────────────────────

/** Agent registration */
export interface RegisterMessage {
  type: "register";
  agent_name: string;
  tools: AgentToolDef[];
  pair_token?: string;
  invite_code?: string;
  group_name?: string;
  metadata?: Record<string, unknown>;
}

/** Registration acknowledgement */
export interface RegisterAckMessage {
  type: "register_ack";
  agent_id: string;
  status: "ok" | "denied" | "pending_approval";
  reason?: string;
  pairing_code?: string;
  /** Discovery payload — included when status is "ok" */
  info?: {
    server_name: string;
    agents: Array<{ id: string; name: string; tools?: string[] }>;
    groups: Array<{ name: string; members: string[] }>;
    chat_routes: Record<string, { agentName?: string; channel?: string }>;
    access: { allowlist: string[]; requireApproval: boolean };
  };
}

/** Heartbeat (keep-alive) */
export interface HeartbeatMessage {
  type: "heartbeat";
}

export interface HeartbeatAckMessage {
  type: "heartbeat_ack";
}

/** Tool call from host to agent */
export interface ToolCallMessage {
  type: "tool_call";
  call_id: string;
  tool_name: string;
  args: Record<string, unknown>;
}

/** Tool result from agent to host */
export interface ToolResultMessage {
  type: "tool_result";
  call_id: string;
  result?: unknown;
  error?: string;
}

/** Shared rich-message parameters accepted by reply / sendMessage tools. */
export interface RichMessageParams {
  format?: "text" | "html" | "markdown";
  files?: Array<{ name: string; mime?: string; path?: string; data?: string; url?: string }>;
  buttons?: Array<{ text: string; action?: string; url?: string }>;
  reply_to?: string;
}

/** Chat message — rich format, each transport renders for its platform */
export interface ChatMessage {
  type: "chat";
  chat_id: string;
  content: string;
  from?: string;
  format?: "text" | "html" | "markdown";
  files?: Array<{ name: string; mime?: string; path?: string /* local */; data?: string /* base64 */; url?: string /* remote */ }>;
  buttons?: Array<{ text: string; action?: string; url?: string }>;
  reply_to?: string;
  meta?: Record<string, string>;
}

/** Reply message */
export interface ReplyMessage {
  type: "reply";
  chat_id: string;
  text: string;
  from?: string;
  format?: "text" | "html" | "markdown";
  files?: Array<{ name: string; mime?: string; path?: string; data?: string; url?: string }>;
  buttons?: Array<{ text: string; action?: string; url?: string }>;
  reply_to?: string;
}

/** Permission request from host */
export interface PermissionRequestMessage {
  type: "permission_request";
  request: {
    request_id: string;
    tool_name: string;
    description: string;
    input_preview: string;
  };
}

/** Permission verdict from agent */
export interface PermissionVerdictMessage {
  type: "permission_verdict";
  request_id: string;
  behavior: "allow" | "deny";
}

/** File transfer (base64) */
export interface FileTransferMessage {
  type: "file_transfer";
  call_id: string;
  filename: string;
  mime: string;
  data: string; // base64
}

/** Group broadcast */
export interface GroupBroadcastMessage {
  type: "group_broadcast";
  from: string;
  content: string;
  meta?: Record<string, string>;
}

/** Group info */
export interface GroupInfoMessage {
  type: "group_info";
  group_name: string;
  members: Array<{ id: string; name: string; tools: string[] }>;
}

/** Invite to group */
export interface InviteMessage {
  type: "invite";
  invite_code: string;
  group_name: string;
  from: string;
}

/** Agent-initiated release: return chat to host */
export interface ReleaseMessage {
  type: "release";
  chat_id: string;
}

/** Agent-initiated handover: pass chat to another agent */
export interface HandoverRequestMessage {
  type: "handover";
  chat_id: string;
  to_agent: string;
}

/** Acknowledgement for agent-initiated actions */
export interface AckMessage {
  type: "ack";
  ref: string;
  status: "ok" | "error";
  reason?: string;
}

/** Stream start — initiates a streaming session for text, audio, video, or file data */
export interface StreamStartMessage {
  type: "stream_start";
  stream_id: string;
  content_type: "text" | "audio" | "video" | "file";
  meta?: Record<string, string>;
}

/** Stream chunk — a single chunk of streaming data (text or base64-encoded binary) */
export interface StreamChunkMessage {
  type: "stream_chunk";
  stream_id: string;
  data: string;
  seq: number;
}

/** Stream end — signals the end of a streaming session */
export interface StreamEndMessage {
  type: "stream_end";
  stream_id: string;
  meta?: Record<string, string>;
}

// ── Union Type ──────────────────────────────────────────────────────────────

export type ProtocolMessage =
  | RegisterMessage
  | RegisterAckMessage
  | HeartbeatMessage
  | HeartbeatAckMessage
  | ToolCallMessage
  | ToolResultMessage
  | ChatMessage
  | ReplyMessage
  | PermissionRequestMessage
  | PermissionVerdictMessage
  | FileTransferMessage
  | GroupBroadcastMessage
  | GroupInfoMessage
  | InviteMessage
  | ReleaseMessage
  | HandoverRequestMessage
  | AckMessage
  | StreamStartMessage
  | StreamChunkMessage
  | StreamEndMessage;

// ── Tool Definition ─────────────────────────────────────────────────────────

export interface AgentToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

// ── Connected Agent ─────────────────────────────────────────────────────────

export interface ConnectedAgent {
  id: string;
  name: string;
  tools: AgentToolDef[];
  transport: Transport;
  lastHeartbeat: number;
  metadata?: Record<string, unknown>;
  groupName?: string;
}

// ── Transport Interface ─────────────────────────────────────────────────────
// Every transport adapter implements this interface.

export interface Transport {
  /** Transport type identifier */
  readonly type: string;

  /** Send a message to this connection */
  send(message: ProtocolMessage): Promise<void>;

  /** Close the connection */
  close(): Promise<void>;

  /** Whether the connection is currently open */
  readonly connected: boolean;
}

// ── Transport Adapter Interface ─────────────────────────────────────────────
// A transport adapter creates/manages connections for a specific transport type.

export interface TransportAdapter {
  /** Transport type identifier */
  readonly type: string;

  /** Start listening for connections (server mode) */
  listen(port: number, handler: ConnectionHandler): Promise<void>;

  /** Connect to a remote endpoint (client mode) */
  connect(url: string, handler: MessageHandler): Promise<Transport>;

  /** Stop listening / disconnect all */
  close(): Promise<void>;
}

export type ConnectionHandler = (transport: Transport) => void;
export type MessageHandler = (message: ProtocolMessage) => void;

// ── Serialization ───────────────────────────────────────────────────────────

export function serialize(message: ProtocolMessage): string {
  return JSON.stringify(message);
}

export function deserialize(data: string): ProtocolMessage {
  return JSON.parse(data) as ProtocolMessage;
}

/** Serialize for binary transports (Bluetooth, USB) */
export function serializeBuffer(message: ProtocolMessage): Buffer {
  return Buffer.from(JSON.stringify(message));
}

export function deserializeBuffer(data: Buffer): ProtocolMessage {
  return JSON.parse(data.toString()) as ProtocolMessage;
}

// ── Discovery ───────────────────────────────────────────────────────────────
// Find servers via local port scan, mDNS, or relay registry.

export interface DiscoveredServer {
  url: string;           // e.g. "ws://192.168.1.50:9090"
  name?: string;         // server name if available
  agents?: number;       // number of connected agents
  source: "local" | "mdns" | "relay" | "manual";
  metadata?: Record<string, unknown>;
}

export type DiscoverySource = "local" | "mdns" | "relay" | "all";

/**
 * Discover Talon servers.
 * - local: scan common ports on localhost + LAN
 * - mdns: multicast DNS (if available)
 * - relay: query a relay registry URL
 */
export async function discover(
  opts: { source?: DiscoverySource; relayUrl?: string; ports?: number[]; timeout?: number } = {},
): Promise<DiscoveredServer[]> {
  const source = opts.source ?? "all";
  const timeout = opts.timeout ?? 3000;
  const results: DiscoveredServer[] = [];

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

async function discoverLocal(ports: number[], timeout: number): Promise<DiscoveredServer[]> {
  const found: DiscoveredServer[] = [];

  // Check localhost
  for (const port of ports) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      const res = await fetch(`http://localhost:${port}/health`, { signal: controller.signal });
      clearTimeout(timer);
      if (res.ok) {
        const data = await res.json().catch(() => ({})) as any;
        found.push({
          url: `ws://localhost:${port}`,
          name: data.name ?? `localhost:${port}`,
          agents: data.agents,
          source: "local",
          metadata: data,
        });
      }
    } catch {
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
            if (ip === net.address) continue;
            for (const port of ports.slice(0, 2)) { // only first 2 ports for LAN
              try {
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), Math.min(timeout, 1000));
                const res = await fetch(`http://${ip}:${port}/health`, { signal: controller.signal });
                clearTimeout(timer);
                if (res.ok) {
                  const data = await res.json().catch(() => ({})) as any;
                  found.push({
                    url: `ws://${ip}:${port}`,
                    name: data.name ?? `${ip}:${port}`,
                    agents: data.agents,
                    source: "local",
                    metadata: data,
                  });
                }
              } catch {}
            }
          }
        }
      }
    }
  } catch {}

  return found;
}

async function discoverMdns(timeout: number): Promise<DiscoveredServer[]> {
  // mDNS discovery — uses the mesh module if available
  try {
    const { MeshDiscovery } = await import("./mesh.js");
    const discovery = new MeshDiscovery({ meshSecret: "", agentName: "discover", port: 0 });
    const found: DiscoveredServer[] = [];

    discovery.on("peerDiscovered", (peer: any) => {
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
  } catch {
    return []; // mDNS not available
  }
}

async function discoverRelay(relayUrl: string, timeout: number): Promise<DiscoveredServer[]> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const res = await fetch(`${relayUrl}/peers`, { signal: controller.signal });
    clearTimeout(timer);

    if (!res.ok) return [];
    const peers = await res.json() as any[];

    return peers.map((p) => ({
      url: p.url ?? `ws://${p.ip ?? p.host}:${p.port}`,
      name: p.name ?? p.id,
      agents: p.agents,
      source: "relay" as const,
      metadata: p,
    }));
  } catch {
    return [];
  }
}

// ── Session Envelope ────────────────────────────────────────────────────────
// Wraps any message in a standard envelope with routing metadata.
// Inspired by the happy-cli SessionEnvelope pattern.

/** Standard envelope that wraps all routed messages */
export interface SessionEnvelope {
  id: string;          // unique message ID
  timestamp: number;
  from: string;        // sender agent ID/name
  to?: string;         // target agent (undefined = broadcast)
  type: "chat" | "tool_call" | "tool_result" | "system" | "handover";
  payload: any;        // the actual message content
  session?: string;    // session/conversation ID
}

/** Recipient filter for the EventRouter */
export type RecipientFilter = "broadcast" | "agent-only" | "host-only" | "session-scoped";

let _envelopeCounter = 0;

/** Create a SessionEnvelope wrapping a payload */
export function createEnvelope(
  from: string,
  type: SessionEnvelope["type"],
  payload: any,
  opts?: { to?: string; session?: string },
): SessionEnvelope {
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

// ── Transport Registry ──────────────────────────────────────────────────────
// Register custom transport adapters at runtime. Agents can add new transports
// (Bluetooth, MQTT, gRPC, etc.) without modifying the SDK.

export type ChannelFactory = (config: Record<string, unknown>) => TransportAdapter;
/** @deprecated Use ChannelFactory */
export type TransportFactory = ChannelFactory;

const channelRegistry = new Map<string, ChannelFactory>();

/** Register a channel adapter factory */
export function registerChannel(type: string, factory: ChannelFactory): void {
  channelRegistry.set(type, factory);
}

/** Create a channel adapter by type */
export function createChannel(type: string, config: Record<string, unknown> = {}): TransportAdapter {
  const factory = channelRegistry.get(type);
  if (!factory) {
    throw new Error(`Unknown channel: ${type}. Registered: ${[...channelRegistry.keys()].join(", ")}`);
  }
  return factory(config);
}

/** List registered channel types */
export function listChannels(): string[] {
  return [...channelRegistry.keys()];
}

/** @deprecated Use registerChannel */
export const registerTransport = registerChannel;
/** @deprecated Use createChannel */
export const createTransport = createChannel;
/** @deprecated Use listChannels */
export const listTransports = listChannels;

// ── Message Type Registry ───────────────────────────────────────────────────
// Register custom message types at runtime. Agents can extend the protocol
// with new message types without modifying the SDK.

export type MessageTypeHandler = (message: any, context: { transport: Transport; agents: Map<string, ConnectedAgent> }) => Promise<void>;

const messageTypeRegistry = new Map<string, MessageTypeHandler>();

/** Register a custom message type handler */
export function registerMessageType(type: string, handler: MessageTypeHandler): void {
  messageTypeRegistry.set(type, handler);
}

/** Get handler for a message type */
export function getMessageHandler(type: string): MessageTypeHandler | undefined {
  return messageTypeRegistry.get(type);
}

/** List registered custom message types */
export function listMessageTypes(): string[] {
  return [...messageTypeRegistry.keys()];
}
