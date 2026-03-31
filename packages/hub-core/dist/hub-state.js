/**
 * All mutable domain state that was previously scattered across ChannelHub
 * field declarations.  ChannelHub now holds a single `state: HubState`
 * instance and delegates to it via getters for backwards compatibility.
 */
export class HubState {
    /** Connected agents keyed by ID. */
    agents = new Map();
    /** Running servers keyed by "type:port" (e.g. "unix:9090", "ws:9090"). */
    servers = new Map();
    /** Outbound client connections keyed by URL. */
    clients = new Map();
    /** In-flight tool calls awaiting responses. */
    pendingCalls = new Map();
    /** Agents awaiting approval (pairing flow). */
    pendingAgents = new Map();
    /** Chat-to-agent routing: chatId → agentId. */
    chatRoutes = new Map();
    /** Chat-to-channel mapping: chatId → ClientEntry that owns the chat. */
    channelForChat = new Map();
    /** Unified target registry: uuid → TargetEntry. Each (channel, entity) pair has one UUID. */
    targetRegistry = new Map();
    /** Name → UUID index for fast target resolution. */
    targetNameIndex = new Map();
    /** Agent groups: groupName → (qualifiedMember → GroupMember). */
    groups = new Map();
    /** Named contacts for human-friendly name resolution. */
    contacts = new Map();
    /** Messages buffered for offline agents. Key = agent name. */
    messageBuffer = new Map();
    /** Seen msgIds for flood deduplication. Key = msgId, value = timestamp (ms). */
    seenMessages = new Map();
    /** Public keys of known peers (agent name → base64 public key). */
    peerKeys = new Map();
    /** E2E encryption sessions per agent. Key = agent name. */
    e2eSessions = new Map();
}
//# sourceMappingURL=hub-state.js.map