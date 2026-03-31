/**
 * Claude Channels SDK — ChannelServer
 *
 * Core class wrapping MCP Server with:
 * - claude/channel capability (bidirectional chat)
 * - claude/channel/permission capability (permission relay)
 * - Unix socket IPC for receiving all 23 hook events from command hooks
 * - Event emitter for clients to subscribe to everything
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { EventEmitter } from "node:events";
import type { ChannelServerOptions, ChannelPermissionVerdict, HookResponse, HookEventHandler, PermissionRequestHandler, ChatReplyHandler, ToolCallHandler, AccessState, PendingPairing, AccessMode } from "./types.js";
export declare class ChannelServer extends EventEmitter {
    private sessions;
    private primarySessionId;
    private sessionServer;
    private ipcServer;
    private socketPath;
    private sessionSocketPath;
    private options;
    private pendingHooks;
    private hookHandler;
    private permissionHandler;
    private replyHandler;
    private toolHandler;
    private accessState;
    private accessPath;
    private accessOpts;
    constructor(opts: ChannelServerOptions);
    /** Get health status of the channel server */
    health(): {
        status: "ok" | "degraded" | "down";
        sessions: number;
        uptime: number;
        pendingHooks: number;
        pendingPairings: number;
        access: {
            mode: string;
            approved: number;
            admins: number;
        };
    };
    /** Get the primary session's MCP Server (backward compat) */
    get mcp(): Server;
    /** Get all session IDs */
    getSessionIds(): string[];
    /** Get session count */
    get sessionCount(): number;
    /** Get or set the agent display name */
    get agentName(): string | undefined;
    set agentName(name: string | undefined);
    private createSessionServer;
    private genSessionId;
    /** Start IPC socket + connect MCP session over stdio.
     *  If another instance is already running (IPC socket exists), connects
     *  as a secondary session via the session socket instead of starting fresh. */
    start(): Promise<void>;
    /** Probe the session socket to check if a primary instance is alive */
    private probeSessionSocket;
    /** Start as a secondary instance — connect stdio MCP through the session socket to the primary */
    private startAsSecondary;
    /** Push a message into Claude's session(s) via channel notification */
    pushMessage(content: string, meta?: Record<string, string>, sessionId?: string): Promise<void>;
    /** Send a permission verdict back to Claude Code */
    sendPermissionVerdict(verdict: ChannelPermissionVerdict, sessionId?: string): Promise<void>;
    /** Resolve a pending blocking hook with a response */
    resolveHook(id: string, response: HookResponse): void;
    /** Register handler for all hook events */
    onHookEvent(handler: HookEventHandler): void;
    /** Register handler for permission relay requests */
    onPermissionRequest(handler: PermissionRequestHandler): void;
    /** Register handler for Claude's reply tool calls */
    onReply(handler: ChatReplyHandler): void;
    /** Register handler for extra tool calls */
    onToolCall(handler: ToolCallHandler): void;
    /** Get the Unix socket path for hook scripts to connect to */
    getSocketPath(): string;
    /** Load access state from disk */
    loadAccess(): Promise<void>;
    /** Save access state to disk */
    saveAccess(): Promise<void>;
    /** Get current access state (read-only copy) */
    getAccessState(): AccessState;
    /** Check if an identity is allowed */
    isAllowed(identity: string): boolean;
    /** Check if an identity is an admin */
    isAdmin(identity: string): boolean;
    /**
     * Request pairing for an unknown identity.
     * Returns the pairing code if a new request was created,
     * or the existing code if already pending.
     */
    requestPairing(identity: string, displayName: string, chatId: string, channel: string, metadata?: Record<string, unknown>): Promise<{
        code: string;
        isNew: boolean;
        autoApproved?: boolean;
    }>;
    /**
     * Approve a pending pairing by code.
     * Returns the approved identity or null if not found.
     */
    approve(code: string, asAdmin?: boolean): Promise<PendingPairing | null>;
    /** Revoke access for an identity */
    revoke(identity: string): Promise<boolean>;
    /** Set access mode */
    setAccessMode(mode: AccessMode): Promise<void>;
    /** List pending pairings */
    getPendingPairings(): PendingPairing[];
    private generateCode;
    /** Generate the settings.json hooks configuration for all events */
    generateHooksConfig(hookScriptPath: string): Record<string, unknown>;
    /** Clean up socket files on shutdown */
    cleanup(): void;
    private setupToolsForServer;
    private setupPermissionRelayForServer;
    private startSessionServer;
    private handleSessionConnection;
    private defaultSocketPath;
    private startIpcServer;
    private handleIpcConnection;
    private handleIpcMessage;
    private handleHookEvent;
    private sendIpcResponse;
}
//# sourceMappingURL=channel-server.d.ts.map