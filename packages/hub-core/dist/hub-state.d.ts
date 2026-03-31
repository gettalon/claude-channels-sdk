/**
 * HubState — Centralized mutable state for ChannelHub.
 *
 * Extracted per the architecture blueprint (Step 1: Extract HubState)
 * to reduce the surface area of ChannelHub and make state easier to
 * inspect, snapshot, and test independently.
 */
import type { RichMessageParams } from "@gettalon/protocol";
import type { AgentState, PendingAgent, GroupMember, ContactEntry, TargetEntry, ClientEntry } from "./types.js";
/** Entry in the offline message buffer. */
export interface BufferedMessage {
    content: string;
    from: string;
    rich?: RichMessageParams;
}
/**
 * All mutable domain state that was previously scattered across ChannelHub
 * field declarations.  ChannelHub now holds a single `state: HubState`
 * instance and delegates to it via getters for backwards compatibility.
 */
export declare class HubState {
    /** Connected agents keyed by ID. */
    readonly agents: Map<string, AgentState>;
    /** Running servers keyed by "type:port" (e.g. "unix:9090", "ws:9090"). */
    readonly servers: Map<string, {
        type: string;
        port?: number;
        httpServer?: any;
        wss?: any;
    }>;
    /** Outbound client connections keyed by URL. */
    readonly clients: Map<string, ClientEntry>;
    /** In-flight tool calls awaiting responses. */
    readonly pendingCalls: Map<string, {
        resolve: (v: unknown) => void;
        reject: (e: Error) => void;
        timer: ReturnType<typeof setTimeout>;
    }>;
    /** Agents awaiting approval (pairing flow). */
    readonly pendingAgents: Map<string, PendingAgent>;
    /** Chat-to-agent routing: chatId → agentId. */
    readonly chatRoutes: Map<string, string>;
    /** Chat-to-channel mapping: chatId → ClientEntry that owns the chat. */
    readonly channelForChat: Map<string, ClientEntry>;
    /** Unified target registry: uuid → TargetEntry. Each (channel, entity) pair has one UUID. */
    readonly targetRegistry: Map<string, TargetEntry>;
    /** Name → UUID index for fast target resolution. */
    readonly targetNameIndex: Map<string, string>;
    /** Agent groups: groupName → (qualifiedMember → GroupMember). */
    readonly groups: Map<string, Map<string, GroupMember>>;
    /** Named contacts for human-friendly name resolution. */
    readonly contacts: Map<string, ContactEntry>;
    /** Messages buffered for offline agents. Key = agent name. */
    readonly messageBuffer: Map<string, BufferedMessage[]>;
    /** Seen msgIds for flood deduplication. Key = msgId, value = timestamp (ms). */
    readonly seenMessages: Map<string, number>;
    /** Public keys of known peers (agent name → base64 public key). */
    readonly peerKeys: Map<string, string>;
    /** E2E encryption sessions per agent. Key = agent name. */
    readonly e2eSessions: Map<string, any>;
}
//# sourceMappingURL=hub-state.d.ts.map