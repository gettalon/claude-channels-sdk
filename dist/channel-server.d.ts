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
import type { ChannelServerOptions, ChannelPermissionVerdict, HookResponse, HookEventHandler, PermissionRequestHandler, ChatReplyHandler, ToolCallHandler } from "./types.js";
export declare class ChannelServer extends EventEmitter {
    private mcpServer;
    private ipcServer;
    private socketPath;
    private options;
    private pendingHooks;
    private hookHandler;
    private permissionHandler;
    private replyHandler;
    private toolHandler;
    constructor(opts: ChannelServerOptions);
    /** The underlying MCP Server instance */
    get mcp(): Server;
    /** Start IPC socket + connect MCP over stdio */
    start(): Promise<void>;
    /** Push a message into Claude's session via channel notification */
    pushMessage(content: string, meta?: Record<string, string>): Promise<void>;
    /** Send a permission verdict back to Claude Code */
    sendPermissionVerdict(verdict: ChannelPermissionVerdict): Promise<void>;
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
    /** Generate the settings.json hooks configuration for all events */
    generateHooksConfig(hookScriptPath: string): Record<string, unknown>;
    /** Clean up socket file on shutdown */
    cleanup(): void;
    private setupTools;
    private setupPermissionRelay;
    private defaultSocketPath;
    private startIpcServer;
    private handleIpcConnection;
    private handleIpcMessage;
    private handleHookEvent;
    private sendIpcResponse;
}
//# sourceMappingURL=channel-server.d.ts.map