import { EventEmitter } from "node:events";
import type { AgentToolDef, SessionEnvelope, RecipientFilter } from "./protocol.js";
export declare function randomAgentName(): string;
/** Ensure machine ID is loaded before generating agent names. Call early in startup. */
export declare function ensureMachineId(): Promise<void>;
export interface AgentState {
    id: string;
    name: string;
    tools: AgentToolDef[];
    ws: any;
    lastHeartbeat: number;
    address?: string;
    metadata?: Record<string, unknown>;
    groupName?: string;
    /** Channel types this agent is allowed to use. Empty/undefined = all allowed. */
    allowedChannels?: string[];
    /** Agent names/IDs this agent is allowed to communicate with. Empty/undefined = all allowed. */
    allowedAgents?: string[];
    /** Keywords/intents this agent can handle, used for content-based routing. */
    intents?: string[];
}
export interface PendingAgent {
    code: string;
    name: string;
    address: string;
    tools: AgentToolDef[];
    ws: any;
    metadata?: Record<string, unknown>;
    requestedAt: number;
}
/** Supported hub lifecycle hook events */
export type HubHookEvent = "postSetup" | "onServerStart" | "onAgentConnect" | "onAgentDisconnect" | "onMessage" | "onReload";
/** A programmatic hook function */
export type HubHookFn = (...args: any[]) => Promise<void>;
/** A shell command hook — executed via child_process.exec */
export interface ShellCommandHook {
    event: HubHookEvent;
    command: string;
}
/** A channel endpoint associated with a contact (e.g. telegram chat, WS agent). */
export interface ContactChannel {
    type: string;
    id: string;
    url: string;
}
/** A named contact entry for human-friendly name resolution. */
export interface ContactEntry {
    name: string;
    channels: ContactChannel[];
}
export interface HubSettings {
    servers?: Array<{
        url: string;
        name?: string;
        port?: number;
        pid?: number;
        startedAt?: string;
    }>;
    connections?: Array<{
        url: string;
        name?: string;
        transport?: string;
        connectedAt?: string;
        config?: Record<string, unknown>;
        remoteInfo?: {
            server_name?: string;
            agents?: Array<{
                id: string;
                name: string;
                tools?: string[];
            }>;
            groups?: Array<{
                name: string;
                members: string[];
            }>;
            chat_routes?: Record<string, {
                agentName?: string;
            }>;
            cachedAt?: string;
        };
    }>;
    transports?: Record<string, Record<string, unknown> | Array<Record<string, unknown>>>;
    access?: {
        allowlist?: string[];
        denylist?: string[];
        requireApproval?: boolean;
    };
    hooks?: Array<{
        event: string;
        command: string;
    }>;
    contacts?: Record<string, {
        name: string;
        channels: Array<{
            type: string;
            id: string;
            url: string;
        }>;
    }>;
    state?: {
        chatRoutes?: Record<string, {
            agentName: string;
            channel?: string;
            channelUrl?: string;
        }>;
        groups?: Record<string, string[]>;
        targets?: Record<string, {
            name: string;
            channelType: string;
            rawId: string;
            kind: string;
        }>;
    };
    [key: string]: unknown;
}
export interface UpdateInfo {
    currentVersion: string;
    latestVersion: string;
    updateAvailable: boolean;
}
export interface HubOptions {
    name?: string;
    port?: number;
    autoStart?: boolean;
    autoConnect?: boolean;
    autoUpdate?: boolean;
    /** Dev mode: enable file watcher + auto-sync (git fetch/pull/build every 60s). Off by default. */
    devMode?: boolean;
    agentName?: string;
    clientTools?: AgentToolDef[];
    onToolCall?: (name: string, args: Record<string, unknown>) => Promise<unknown>;
    hooks?: Record<string, Array<HubHookFn>>;
    /** When false, disables all hook execution. Default: true. */
    hooksEnabled?: boolean;
    /** When true (default), local connections (localhost/127.0.0.1) try unix socket first, falling back to WS. */
    preferLocalIpc?: boolean;
    /** Directory for per-agent config files (defaults to ~/.talon/agents) */
    agentConfigDir?: string;
    /** Bot username to strip from incoming messages (e.g. "MyBot_bot" strips "@MyBot_bot" prefix). */
    botUsername?: string;
}
export { setSettingsPath } from "./hub-settings.js";
import type { CommandDef, CommandResult } from "./hub-commands.js";
import type { HubFacade, TargetSummary, ServerSummary } from "./hub-facade.js";
/** A member of a group with a receive mode. */
export interface GroupMember {
    /** Qualified name, e.g. "ws:backend", "telegram:938185675", "agent:dexter" */
    name: string;
    /** Receive mode: "all" = every message, "@only" = only when @mentioned */
    mode: "all" | "@only";
    /** Agent UUID — populated for remote members synced via group_sync */
    agentId?: string;
    /** Agent display name — populated for remote members synced via group_sync */
    agentName?: string;
}
/** Unified target entry — each (channel, entity) pair gets a stable UUID. */
export interface TargetEntry {
    /** Canonical UUID for this target */
    uuid: string;
    /** Human-readable name (e.g. "telegram", "test-9091", "Home Claude", "echo-bot") */
    name: string;
    /** Channel/transport type (e.g. "telegram", "websocket", "unix", "agent") */
    channelType: string;
    /** Raw channel-specific ID (e.g. Telegram chat_id, agent ID, socket URL) */
    rawId: string;
    /** "agent" | "user" | "group" | "channel" */
    kind: "agent" | "user" | "group" | "channel";
    /** Source connection URL that owns this target (e.g. "telegram://main-bot").
     *  Disambiguates same rawId across multiple bots/channels. */
    sourceUrl?: string;
}
export interface HealthSnapshot {
    servers: Array<{
        id: string;
        healthy: boolean;
        port?: number;
    }>;
    clients: Array<{
        url: string;
        healthy: boolean;
        channel: string;
    }>;
    agents: {
        total: number;
        stale: number;
    };
    uptime: number;
}
export type ClientEntry = {
    id: string;
    url: string;
    channelId: string;
    transport: string;
    role: "server" | "channel" | "relay";
    ws: any;
    name: string;
    heartbeatTimer?: ReturnType<typeof setInterval>;
};
export declare class ChannelHub extends EventEmitter implements HubFacade {
    readonly name: string;
    readonly defaultPort: number;
    readonly agents: Map<string, AgentState>;
    readonly servers: Map<string, {
        type: string;
        port?: number;
        httpServer?: any;
        wss?: any;
    }>;
    readonly clients: Map<string, ClientEntry>;
    readonly pendingCalls: Map<string, {
        resolve: (v: unknown) => void;
        reject: (e: Error) => void;
        timer: ReturnType<typeof setTimeout>;
    }>;
    readonly pendingAgents: Map<string, PendingAgent>;
    readonly chatRoutes: Map<string, string>;
    readonly channelForChat: Map<string, ClientEntry>;
    /** Unified target registry: uuid -> TargetEntry. Each (channel, entity) pair has one UUID. */
    readonly targetRegistry: Map<string, TargetEntry>;
    /** Name -> UUID lookup for fast resolution. */
    readonly targetNameIndex: Map<string, string>;
    readonly groups: Map<string, Map<string, GroupMember>>;
    readonly contacts: Map<string, ContactEntry>;
    readonly startedAt: number;
    private callIdCounter;
    private proxyIdCounter;
    private opts;
    private clientTools;
    private readonly hookRegistry;
    private shellHooks;
    private healthMonitorTimer;
    private lastPersistedStateJson;
    private readonly agentConfigDir;
    private readonly pendingProxyCalls;
    private fileWatcher;
    readonly peerKeys: Map<string, string>;
    /** E2E encryption sessions per agent. Key = agent name, value = E2eSession. */
    readonly e2eSessions: Map<string, import("./mesh.js").E2eSession>;
    /** Hub identity keypair — loaded lazily on first key exchange. */
    private _identity;
    /** Messages buffered for offline agents. Key = agent name, value = queued messages (max 100 per agent). */
    private readonly messageBuffer;
    private static readonly MAX_BUFFERED_MESSAGES;
    /** Seen msgIds for flood deduplication. Key = msgId, value = timestamp (ms). */
    readonly seenMessages: Map<string, number>;
    private static readonly SEEN_MSG_TTL_MS;
    /** Returns true if this msgId was already seen (dedup check). Adds to seen-set if new. */
    seenOrTrack(msgId: string): boolean;
    /** Evict expired seen message IDs (called periodically by the server). */
    evictSeenMessages(): void;
    constructor(opts?: HubOptions);
    /**
     * Buffer a message for an agent that is currently offline.
     * Messages are capped at MAX_BUFFERED_MESSAGES per agent.
     */
    bufferMessage(agentName: string, content: string, from: string, rich?: import("./protocol.js").RichMessageParams): void;
    /**
     * Flush all buffered messages for an agent that just connected.
     * Sends each message via the agent's WebSocket.
     */
    flushBufferedMessages(agentName: string): void;
    static getVersion: () => string;
    checkForUpdates: () => Promise<UpdateInfo>;
    autoUpdate: () => Promise<UpdateInfo & {
        updated: boolean;
    }>;
    hook: (event: HubHookEvent, fn: HubHookFn) => this;
    addShellHook: (event: HubHookEvent, command: string) => Promise<void>;
    /** @internal */ loadShellHooks: () => Promise<void>;
    /** @internal */ fireHooks: (event: HubHookEvent, ...args: any[]) => Promise<void>;
    /** @internal */ execShellHook: (command: string, event: string, args: any[]) => Promise<void>;
    registerCommand: (def: CommandDef) => void;
    executeCommand: (text: string, context?: {
        chatId?: string;
        user?: string;
    }) => Promise<CommandResult | null>;
    listCommands: () => CommandDef[];
    /** Ensure machine ID is loaded. Instance method that delegates to the module-level function. */
    ensureMachineId(): Promise<void>;
    /** Generate a random agent name using the machine ID. */
    randomAgentName(): string;
    serverRunning(): boolean;
    /** True if connected to a remote server (WS/Unix) — not counting channel connections (Telegram, etc.) */
    clientConnected(): boolean;
    /** Get first server connection WS */
    getClientWs(): any;
    /** All connected channels (including server connections) */
    allChannels(): ClientEntry[];
    /** Only channel connections (Telegram, Discord, etc. — not server) */
    channelConnections(): ClientEntry[];
    /** True when this instance is a client (connected to a remote server, not running its own server). */
    isClient(): boolean;
    /**
     * Send a proxy_command to the server and wait for the result.
     * Used by client instances to delegate all state operations to the server.
     */
    private proxyToServer;
    findAgent(idOrName: string): AgentState | undefined;
    /** List all agents. Proxies to server when in client mode to get the global agent list. */
    listAgents(): Array<{
        id: string;
        name: string;
        tools: string[];
        lastHeartbeat: number;
    }> | Promise<Array<{
        id: string;
        name: string;
        tools: string[];
        lastHeartbeat: number;
    }>>;
    wsSend(ws: any, data: any): void;
    /** Find the E2E session associated with a WebSocket (if any). */
    private getE2eSessionForWs;
    /**
     * Like wsSend but handles async transport sends (e.g., Telegram API calls).
     * Logs errors and emits 'sendFailed' event for observability.
     * Note: returns void immediately — delivery is fire-and-forget.
     * Use the 'sendFailed' event to detect failed deliveries.
     */
    wsSendAsync(ws: any, data: any): void;
    callRemoteTool(agentId: string, toolName: string, args: Record<string, unknown>): Promise<unknown>;
    sendMessage: (target: string | undefined, content: string, rich?: import("./protocol.js").RichMessageParams) => {
        ok: boolean;
        error?: string;
    };
    reply: (chatId: string, text: string, rich?: import("./protocol.js").RichMessageParams) => {
        ok: boolean;
        error?: string;
    };
    wrapEnvelope: (payload: any, opts?: {
        to?: string;
        session?: string;
    }) => SessionEnvelope;
    route: (envelope: SessionEnvelope, filter?: RecipientFilter) => number;
    handover: (chatId: string, toAgentId: string) => {
        ok: boolean;
        error?: string;
    } | Promise<{
        ok: boolean;
        error?: string;
    }>;
    getChatRoute: (chatId: string) => string | undefined | Promise<string | undefined>;
    releaseChat: (chatId: string) => {
        ok: boolean;
        error?: string;
    } | Promise<{
        ok: boolean;
        error?: string;
    }>;
    displayName: (chatId: string) => string;
    findTarget: (nameOrId: string) => TargetEntry | undefined;
    /** @internal */ resolvedName: () => string;
    /** @internal */ clearRoute: (chatId: string) => void;
    /** @internal */ emitMessage: (content: string, chatId: string, user: string) => void;
    /** @internal */ resolveTarget: (target: string) => string;
    /** @internal */ trySendToRoute: (chatId: string, content: string, from: string, rich?: import("./protocol.js").RichMessageParams) => boolean;
    /** @internal */ routeChat: (params: {
        chatId: string;
        content: string;
        from: string;
        source: "agent" | "channel";
        senderAgentId?: string;
        sourceUrl?: string;
    }) => void;
    startServer: (port?: number, opts?: {
        http?: boolean;
    }) => Promise<{
        port: number;
    }>;
    /** @internal */ startHttpWs: (port: number) => Promise<void>;
    /** @internal */ setupAgentConnection: (ws: any, addr: string) => void;
    /** @internal */ completeRegistration: (ws: any, addr: string, agentName: string, tools: AgentToolDef[], metadata: any, ref: {
        id: string | null;
    }) => void;
    private generatePairingCode;
    /** Approve a pending agent by pairing code. Adds to allowlist and completes registration. */
    approveAgent(code: string): Promise<{
        ok: boolean;
        name?: string;
        error?: string;
    }>;
    /** Deny a pending agent by pairing code. Closes the connection. */
    denyAgent(code: string): {
        ok: boolean;
        name?: string;
        error?: string;
    };
    /** List all pending agent approvals */
    listPendingAgents(): Array<{
        code: string;
        name: string;
        address: string;
        tools: string[];
        requestedAt: number;
    }>;
    /** Parse a qualified member string ("ws:name") into [prefix, name]. */
    private parseGroupMember;
    /** Resolve a qualified member to a sendMessage target. */
    private resolveGroupTarget;
    /** Extract bare name from a qualified member string. */
    private groupMemberName;
    /** Create a new group. */
    createGroup(name: string): {
        ok: boolean;
        error?: string;
    } | Promise<{
        ok: boolean;
        error?: string;
    }>;
    /**
     * Add a member to a group. Creates the group if it doesn't exist.
     *
     * Accepts "type:name" format (e.g. "ws:backend", "telegram:12345", "agent:dexter")
     * or bare names which are auto-resolved by checking connected agents.
     *
     * @param receiveMode  "all" (default) or "@only" (only when @mentioned)
     */
    addToGroup(groupName: string, member: string, receiveMode?: "all" | "@only"): {
        ok: boolean;
        error?: string;
    } | Promise<{
        ok: boolean;
        error?: string;
    }>;
    /** Broadcast a group membership change to all hub peers (role="server" clients). */
    private broadcastGroupSync;
    /** Notify existing WS members about a new joiner, and notify the new joiner about existing members. */
    notifyGroupJoin(groupName: string, qualifiedNewMember: string): void;
    /** Remove a member from a group. Accepts qualified or bare name. */
    removeFromGroup(groupName: string, member: string): {
        ok: boolean;
        error?: string;
    } | Promise<{
        ok: boolean;
        error?: string;
    }>;
    /** Delete a group entirely. */
    deleteGroup(name: string): {
        ok: boolean;
        error?: string;
    } | Promise<{
        ok: boolean;
        error?: string;
    }>;
    /** List all groups with their members. */
    listGroups(): Array<{
        name: string;
        members: GroupMember[];
    }> | Promise<Array<{
        name: string;
        members: GroupMember[];
    }>>;
    /**
     * Broadcast a message to all group members (except sender).
     * Members with mode "@only" only receive if @mentioned in the message.
     * All members with mode "all" always receive.
     */
    broadcastToGroup(groupName: string, content: string, from: string): {
        ok: boolean;
        sent: number;
        error?: string;
    } | Promise<{
        ok: boolean;
        sent: number;
        error?: string;
    }>;
    /** Remove a WS agent from all groups on disconnect. */
    private removeFromAllGroups;
    connect: (url: string, agentName?: string, connectionConfig?: Record<string, unknown>) => Promise<void>;
    /**
     * Check if the daemon is running by verifying both the PID file and that the
     * server port is actually listening.  This avoids races where the PID file
     * exists but the daemon hasn't started its server yet, or the PID file is
     * stale but the port happens to be in use by something else.
     */
    private isDaemonListening;
    /**
     * Check if the process holding a port is a stale orphan (left over from a
     * previous MCP plugin session). If so, kill it and return true so the caller
     * can retry startServer.
     *
     * Detection heuristic:
     *   1. Read the PID from ~/.talon/daemon.pid
     *   2. If no PID file or the PID is not alive -> the port holder is unknown,
     *      not our orphan — return false.
     *   3. If the PID is alive but its parent PID (PPID) is 1 (init/launchd) or
     *      doesn't match our own process tree, it's an orphan from a dead parent.
     *   4. Kill the orphan (SIGTERM, then SIGKILL after a short delay).
     */
    tryKillOrphanOnPort(port: number): Promise<boolean>;
    autoSetup(): Promise<void>;
    /** Start all enabled transports from settings.transports (many-to-many support). */
    private autoConnectTransports;
    /** Watch the SDK's dist/ directory for changes and auto-reload. */
    private startFileWatcher;
    /** Periodically check git remote and pull + build if new commits available. */
    private startAutoSync;
    reload(): Promise<{
        checks: string[];
        issues: string[];
        summary: Record<string, number>;
    }>;
    loadSettings: () => Promise<HubSettings>;
    loadSettingsSafe: () => Promise<HubSettings>;
    saveSettings: (settings: HubSettings) => Promise<void>;
    registerServer: (url: string, name: string, port: number) => Promise<void>;
    unregisterServer: (port: number) => Promise<void>;
    getRegisteredServers: () => Promise<HubSettings["servers"]>;
    addConnection: (url: string, name: string, config?: Record<string, unknown>) => Promise<void>;
    removeConnection: (url: string) => Promise<void>;
    getConnections: () => Promise<HubSettings["connections"]>;
    persistState: () => Promise<void>;
    restoreState: () => Promise<void>;
    registerContact: (name: string, channelType: string, id: string, url?: string) => {
        ok: boolean;
    };
    removeContact: (name: string) => {
        ok: boolean;
        error?: string;
    };
    resolveContact: (nameOrId: string) => {
        contact: ContactEntry;
        channel: ContactChannel;
    } | undefined;
    listContacts: () => ContactEntry[];
    /** @internal */ autoRegisterContact: (userName: string, chatId: string, channelType: string, url?: string) => void;
    /** @internal */ persistContacts: () => Promise<void>;
    /** @internal */ restoreContacts: () => Promise<void>;
    /** Load all per-agent configs from disk and log them. */
    private loadAgentConfigs;
    /** Persist per-agent config for a specific agent to its own file. */
    persistAgentConfig(agentId: string): Promise<void>;
    /**
     * Scan ~/.talon/agents/{name}/agent.json for agents with status:"running"
     * and relaunch them with their saved config. Auto-restarts agents that
     * were active before the hub shut down.
     */
    private relaunchPersistentAgents;
    private genId;
    /** Infer channel type from a chat_id or connected client info. */
    private inferChannelType;
    /** Get members of a group in protocol format. */
    private getGroupMembers;
    detectTransport(url: string): string;
    /** Check if a URL targets localhost or 127.0.0.1 */
    private isLocalUrl;
    /** Extract port number from a URL (supports ws://, auto://) */
    private extractPort;
    /** Convert auto:// URL to ws:// URL */
    private autoToWsUrl;
    getHealth: () => Promise<HealthSnapshot>;
    startHealthMonitor: (intervalMs?: number) => void;
    stopHealthMonitor: () => void;
    /** Get status summary — proxies to main hub when in client mode */
    getStatus(): Record<string, any> | Promise<Record<string, any>>;
    /** Return a snapshot of the chatRoutes map (chatId → agentId). */
    getChatRoutes(): Map<string, string>;
    /** Return all targets in the target registry as plain summaries. */
    listTargets(): TargetSummary[];
    /** Return all running servers as plain summaries. */
    getServers(): ServerSummary[];
    hasServer(id: string): boolean;
    /** Register a newly connected agent. */
    registerAgent(id: string, state: AgentState): void;
    /** Unregister a disconnected agent by ID. */
    unregisterAgent(id: string): void;
    /** Update heartbeat timestamp for an agent. */
    touchAgentHeartbeat(id: string): void;
    /** Add an agent to the pending approval queue. */
    addPendingAgent(code: string, pending: PendingAgent): void;
    /** Remove an agent from the pending approval queue. */
    removePendingAgent(code: string): void;
    /**
     * Claim ownership of a chat for a specific agent (used during registration/approval).
     * Distinct from handover() which routes between existing active agents.
     */
    claimChat(chatId: string, agentId: string): void;
    /** Register a (channelType, rawId) target pair with a stable UUID. Returns the UUID.
     *  Delegated to hub-routing.ts via installRouting. */
    registerTarget: (name: string, channelType: string, rawId: string, kind: "agent" | "user" | "group" | "channel", sourceUrl?: string) => string;
    /** Remove a target entry by UUID. */
    unregisterTarget(uuid: string): void;
    /** Record which channel client owns a given chat. */
    registerChannelForChat(chatId: string, client: any): void;
    /** Remove channel-for-chat mapping. */
    unregisterChannelForChat(chatId: string): void;
    /** Register an outbound client connection by URL. */
    registerClient(url: string, client: any): void;
    /** Remove an outbound client connection. */
    unregisterClient(url: string): void;
    /**
     * Persistent agent router callback. Used by routeChat (hub-routing.ts)
     * for @agent mention routing when the target is not directly connected.
     * Returns true if the message was handled.
     */
    _persistentAgentRouter: ((name: string, content: string, from: string, chatId: string) => boolean) | null;
    /** Register a persistent agent router for @agent mention routing. */
    registerPersistentAgentRouter(handler: (name: string, content: string, from: string, chatId: string) => boolean): void;
}
//# sourceMappingURL=hub.d.ts.map