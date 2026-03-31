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
export declare const MessageType: {
    readonly REGISTER: "register";
    readonly REGISTER_ACK: "register_ack";
    readonly HEARTBEAT: "heartbeat";
    readonly HEARTBEAT_ACK: "heartbeat_ack";
    readonly ACK: "ack";
    readonly TOOL_CALL: "tool_call";
    readonly TOOL_RESULT: "tool_result";
    readonly CHAT: "chat";
    readonly REPLY: "reply";
    readonly PERMISSION_REQUEST: "permission_request";
    readonly PERMISSION_VERDICT: "permission_verdict";
    readonly FILE_TRANSFER: "file_transfer";
    readonly GROUP_BROADCAST: "group_broadcast";
    readonly GROUP_INFO: "group_info";
    readonly INVITE: "invite";
    readonly RELEASE: "release";
    readonly HANDOVER_REQUEST: "handover";
    readonly STREAM_START: "stream_start";
    readonly STREAM_CHUNK: "stream_chunk";
    readonly STREAM_END: "stream_end";
};
/** Built-in message types + any custom string */
export type MessageTypeName = typeof MessageType[keyof typeof MessageType] | (string & {});
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
        agents: Array<{
            id: string;
            name: string;
            tools?: string[];
        }>;
        groups: Array<{
            name: string;
            members: string[];
        }>;
        chat_routes: Record<string, {
            agentName?: string;
            channel?: string;
        }>;
        access: {
            allowlist: string[];
            requireApproval: boolean;
        };
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
    files?: Array<{
        name: string;
        mime?: string;
        path?: string;
        data?: string;
        url?: string;
    }>;
    buttons?: Array<{
        text: string;
        action?: string;
        url?: string;
    }>;
    reply_to?: string;
}
/** Chat message — rich format, each transport renders for its platform */
export interface ChatMessage {
    type: "chat";
    chat_id: string;
    content: string;
    from?: string;
    format?: "text" | "html" | "markdown";
    files?: Array<{
        name: string;
        mime?: string;
        path?: string;
        data?: string;
        url?: string;
    }>;
    buttons?: Array<{
        text: string;
        action?: string;
        url?: string;
    }>;
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
    files?: Array<{
        name: string;
        mime?: string;
        path?: string;
        data?: string;
        url?: string;
    }>;
    buttons?: Array<{
        text: string;
        action?: string;
        url?: string;
    }>;
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
    data: string;
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
    members: Array<{
        id: string;
        name: string;
        tools: string[];
    }>;
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
export type ProtocolMessage = RegisterMessage | RegisterAckMessage | HeartbeatMessage | HeartbeatAckMessage | ToolCallMessage | ToolResultMessage | ChatMessage | ReplyMessage | PermissionRequestMessage | PermissionVerdictMessage | FileTransferMessage | GroupBroadcastMessage | GroupInfoMessage | InviteMessage | ReleaseMessage | HandoverRequestMessage | AckMessage | StreamStartMessage | StreamChunkMessage | StreamEndMessage;
export interface AgentToolDef {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
}
export interface ConnectedAgent {
    id: string;
    name: string;
    tools: AgentToolDef[];
    transport: Transport;
    lastHeartbeat: number;
    metadata?: Record<string, unknown>;
    groupName?: string;
}
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
export declare function serialize(message: ProtocolMessage): string;
export declare function deserialize(data: string): ProtocolMessage;
/** Serialize for binary transports (Bluetooth, USB) */
export declare function serializeBuffer(message: ProtocolMessage): Buffer;
export declare function deserializeBuffer(data: Buffer): ProtocolMessage;
export interface DiscoveredServer {
    url: string;
    name?: string;
    agents?: number;
    source: "local" | "mdns" | "relay" | "manual";
    metadata?: Record<string, unknown>;
}
export type DiscoverySource = "local" | "mdns" | "relay" | "all";
/** Standard envelope that wraps all routed messages */
export interface SessionEnvelope {
    id: string;
    timestamp: number;
    from: string;
    to?: string;
    type: "chat" | "tool_call" | "tool_result" | "system" | "handover";
    payload: any;
    session?: string;
}
/** Recipient filter for the EventRouter */
export type RecipientFilter = "broadcast" | "agent-only" | "host-only" | "session-scoped";
/** Create a SessionEnvelope wrapping a payload */
export declare function createEnvelope(from: string, type: SessionEnvelope["type"], payload: any, opts?: {
    to?: string;
    session?: string;
}): SessionEnvelope;
export type ChannelFactory = (config: Record<string, unknown>) => TransportAdapter;
/** @deprecated Use ChannelFactory */
export type TransportFactory = ChannelFactory;
/**
 * Register a channel adapter factory.
 * @param requireE2E - Whether connections over this transport require E2E encryption. Defaults to true.
 */
export declare function registerChannel(type: string, factory: ChannelFactory, { requireE2E }?: {
    requireE2E?: boolean;
}): void;
/** Returns true if the transport requires E2E encryption (defaults to true for unknown transports). */
export declare function transportRequiresE2E(type: string): boolean;
/** Create a channel adapter by type */
export declare function createChannel(type: string, config?: Record<string, unknown>): TransportAdapter;
/** List registered channel types */
export declare function listChannels(): string[];
/** @deprecated Use registerChannel */
export declare const registerTransport: typeof registerChannel;
/** @deprecated Use createChannel */
export declare const createTransport: typeof createChannel;
/** @deprecated Use listChannels */
export declare const listTransports: typeof listChannels;
export type MessageTypeHandler = (message: any, context: {
    transport: Transport;
    agents: Map<string, ConnectedAgent>;
}) => Promise<void>;
/** Register a custom message type handler */
export declare function registerMessageType(type: string, handler: MessageTypeHandler): void;
/** Get handler for a message type */
export declare function getMessageHandler(type: string): MessageTypeHandler | undefined;
/** List registered custom message types */
export declare function listMessageTypes(): string[];
//# sourceMappingURL=index.d.ts.map