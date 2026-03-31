/**
 * WebSocket Channel Adapter
 *
 * Accepts WebSocket connections from edge agents or remote Talon clients.
 * Features:
 * - Server mode: listens for incoming WS connections (edge agents call home)
 * - Client mode: connects to a remote WS server (Talon host)
 * - Agent registration: connected agents register their tools
 * - Tool routing: forward tool calls to connected agents, return results
 * - Binary transfer: images, files via WS binary frames
 * - Heartbeat / auto-reconnect
 * - Authentication via pairing tokens
 * - Multi-agent: multiple edge agents on one server
 */
import { ChannelServer } from "../channel-server.js";
import type { MeshConfig } from "../mesh.js";
export interface GroupInvite {
    code: string;
    /** "private" = one-time, expires; "public" = reusable, no expiry */
    type: "private" | "public";
    groupName: string;
    createdBy: string;
    createdAt: number;
    /** Expiry timestamp (0 = never for public invites) */
    expiresAt: number;
    /** How many times this invite has been used */
    uses: number;
    /** Max uses (0 = unlimited for public invites, 1 for private) */
    maxUses: number;
    /** Optional label for display */
    label?: string;
}
export interface GroupConfig {
    /** Group name */
    name: string;
    /** "public" = anyone can join, "private" = requires pairing code approval, "invite" = invite link only */
    access: "public" | "private" | "invite";
    /** Peer URLs to connect to (this node connects as client to these peers) */
    peers?: string[];
    /** Max members allowed in the group (0 = unlimited, default: 0) */
    maxMembers?: number;
}
export interface WebSocketConfig {
    /** "server" = listen for agents, "client" = connect to host, "both" = server + client (default) */
    mode: "server" | "client" | "both";
    /** Port to listen on (server mode) */
    port?: number;
    /** Host to bind to (server mode, default "0.0.0.0") */
    host?: string;
    /** URL to connect to (client mode, e.g. "ws://talon-host:8080") */
    url?: string;
    /** Agent name for registration */
    agentName?: string;
    /** Pairing token for authentication */
    pairToken?: string;
    /** Heartbeat interval in ms (default: 30000) */
    heartbeatInterval?: number;
    /** Auto-reconnect on disconnect (client mode, default: true) */
    autoReconnect?: boolean;
    /** Tools to register (client/edge mode) */
    tools?: AgentTool[];
    /** Group config — enables group features; node acts as both server and client */
    group?: GroupConfig;
    /** Mesh config — enables mDNS discovery, JWT auth, E2E encryption */
    mesh?: MeshConfig;
    /** Enable HTTP transport alongside WebSocket (default: true) */
    httpEnabled?: boolean;
}
export interface AgentTool {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
}
export interface ConnectedAgent {
    id: string;
    name: string;
    tools: AgentTool[];
    ws: any;
    lastHeartbeat: number;
    metadata?: Record<string, unknown>;
    /** Group name this agent belongs to (if any) */
    groupName?: string;
    /** Whether this is a peer connection (outbound client) vs inbound server connection */
    isPeer?: boolean;
}
export declare function parseConfig(): WebSocketConfig;
export declare function createWebSocketChannel(config?: Partial<WebSocketConfig>): Promise<{
    channel: ChannelServer;
    cleanup: () => void;
    agents: Map<string, ConnectedAgent>;
}>;
//# sourceMappingURL=websocket.d.ts.map