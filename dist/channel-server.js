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
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema, } from "@modelcontextprotocol/sdk/types.js";
import { createServer as createNetServer } from "node:net";
import { unlinkSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { EventEmitter } from "node:events";
import { BLOCKING_EVENTS } from "./types.js";
const DEFAULT_SOCKET_PATH_SUFFIX = "channel-hooks.sock";
const DEFAULT_BLOCKING_TIMEOUT = 30_000;
// ─── ChannelServer ──────────────────────────────────────────────────────────
export class ChannelServer extends EventEmitter {
    mcpServer;
    ipcServer = null;
    socketPath;
    options;
    // Pending blocking hook responses: hook script waiting for client decision
    pendingHooks = new Map();
    // Event handlers
    hookHandler = null;
    permissionHandler = null;
    replyHandler = null;
    toolHandler = null;
    constructor(opts) {
        super();
        this.options = {
            permissionRelay: true,
            blockingTimeout: DEFAULT_BLOCKING_TIMEOUT,
            ...opts,
        };
        this.socketPath = opts.socketPath ?? this.defaultSocketPath();
        // Build MCP capabilities
        const experimental = { "claude/channel": {} };
        if (this.options.permissionRelay) {
            experimental["claude/channel/permission"] = {};
        }
        this.mcpServer = new Server({ name: opts.name, version: opts.version }, {
            capabilities: { experimental, tools: {} },
            instructions: opts.instructions,
        });
        this.setupTools();
        if (this.options.permissionRelay) {
            this.setupPermissionRelay();
        }
    }
    /** The underlying MCP Server instance */
    get mcp() {
        return this.mcpServer;
    }
    // ─── Public API ──────────────────────────────────────────────────────────
    /** Start IPC socket + connect MCP over stdio */
    async start() {
        await this.startIpcServer();
        const transport = new StdioServerTransport();
        await this.mcpServer.connect(transport);
        this.emit("ready");
        process.stderr.write(`[channel-sdk] Ready (socket: ${this.socketPath})\n`);
    }
    /** Push a message into Claude's session via channel notification */
    async pushMessage(content, meta) {
        await this.mcpServer.notification({
            method: "notifications/claude/channel",
            params: { content, ...(meta ? { meta } : {}) },
        });
    }
    /** Send a permission verdict back to Claude Code */
    async sendPermissionVerdict(verdict) {
        await this.mcpServer.notification({
            method: "notifications/claude/channel/permission",
            params: verdict,
        });
    }
    /** Resolve a pending blocking hook with a response */
    resolveHook(id, response) {
        const pending = this.pendingHooks.get(id);
        if (pending) {
            clearTimeout(pending.timer);
            this.pendingHooks.delete(id);
            pending.resolve(response);
        }
    }
    /** Register handler for all hook events */
    onHookEvent(handler) {
        this.hookHandler = handler;
    }
    /** Register handler for permission relay requests */
    onPermissionRequest(handler) {
        this.permissionHandler = handler;
    }
    /** Register handler for Claude's reply tool calls */
    onReply(handler) {
        this.replyHandler = handler;
    }
    /** Register handler for extra tool calls */
    onToolCall(handler) {
        this.toolHandler = handler;
    }
    /** Get the Unix socket path for hook scripts to connect to */
    getSocketPath() {
        return this.socketPath;
    }
    /** Generate the settings.json hooks configuration for all events */
    generateHooksConfig(hookScriptPath) {
        const allEvents = this.options.enabledHooks ?? [
            "SessionStart", "SessionEnd",
            "UserPromptSubmit",
            "PreToolUse", "PostToolUse", "PostToolUseFailure",
            "PermissionRequest",
            "Notification",
            "SubagentStart", "SubagentStop",
            "Stop", "StopFailure",
            "TeammateIdle", "TaskCompleted",
            "InstructionsLoaded",
            "ConfigChange",
            "CwdChanged", "FileChanged",
            "WorktreeCreate", "WorktreeRemove",
            "PreCompact", "PostCompact",
            "Elicitation", "ElicitationResult",
        ];
        const hooks = {};
        for (const event of allEvents) {
            hooks[event] = [
                {
                    hooks: [
                        {
                            type: "command",
                            command: `${hookScriptPath} --socket ${this.socketPath} --event ${event}`,
                            timeout: BLOCKING_EVENTS.has(event) ? 60 : 10,
                        },
                    ],
                },
            ];
        }
        return { hooks };
    }
    /** Clean up socket file on shutdown */
    cleanup() {
        try {
            if (this.ipcServer)
                this.ipcServer.close();
            if (existsSync(this.socketPath))
                unlinkSync(this.socketPath);
        }
        catch { }
    }
    // ─── MCP Tools ──────────────────────────────────────────────────────────
    setupTools() {
        const extraTools = this.options.extraTools ?? [];
        this.mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
            tools: [
                {
                    name: "reply",
                    description: "Send a reply message back through the channel",
                    inputSchema: {
                        type: "object",
                        properties: {
                            chat_id: { type: "string", description: "The chat_id from the channel tag" },
                            text: { type: "string", description: "The message to send" },
                        },
                        required: ["chat_id", "text"],
                    },
                },
                ...extraTools,
            ],
        }));
        this.mcpServer.setRequestHandler(CallToolRequestSchema, async (req) => {
            const { name, arguments: args } = req.params;
            if (name === "reply") {
                const { chat_id, text } = args;
                if (this.replyHandler)
                    this.replyHandler(chat_id, text);
                this.emit("reply", chat_id, text);
                return { content: [{ type: "text", text: "sent" }] };
            }
            // Extra tools
            if (this.toolHandler) {
                const result = await this.toolHandler(name, (args ?? {}));
                if (typeof result === "string") {
                    return { content: [{ type: "text", text: result }] };
                }
                return { content: [{ type: "text", text: JSON.stringify(result) }] };
            }
            throw new Error(`Unknown tool: ${name}`);
        });
    }
    // ─── Permission Relay ────────────────────────────────────────────────────
    setupPermissionRelay() {
        const PermissionRequestSchema = z.object({
            method: z.literal("notifications/claude/channel/permission_request"),
            params: z.object({
                request_id: z.string(),
                tool_name: z.string(),
                description: z.string(),
                input_preview: z.string(),
            }),
        });
        this.mcpServer.setNotificationHandler(PermissionRequestSchema, async ({ params }) => {
            const request = params;
            process.stderr.write(`[channel-sdk] Permission request: ${params.tool_name} (${params.request_id})\n`);
            if (this.permissionHandler)
                this.permissionHandler(request);
            this.emit("permissionRequest", request);
        });
    }
    // ─── IPC Server (Unix Socket) ────────────────────────────────────────────
    defaultSocketPath() {
        const home = process.env.HOME ?? "/tmp";
        return `${home}/.claude/${DEFAULT_SOCKET_PATH_SUFFIX}`;
    }
    async startIpcServer() {
        // Ensure parent directory exists
        const dir = dirname(this.socketPath);
        mkdirSync(dir, { recursive: true });
        // Remove stale socket
        if (existsSync(this.socketPath)) {
            unlinkSync(this.socketPath);
        }
        return new Promise((resolve, reject) => {
            this.ipcServer = createNetServer((socket) => this.handleIpcConnection(socket));
            this.ipcServer.on("error", (err) => {
                process.stderr.write(`[channel-sdk] IPC error: ${err.message}\n`);
                reject(err);
            });
            this.ipcServer.listen(this.socketPath, () => {
                process.stderr.write(`[channel-sdk] IPC listening on ${this.socketPath}\n`);
                resolve();
            });
        });
    }
    handleIpcConnection(socket) {
        let buffer = "";
        socket.on("data", (chunk) => {
            buffer += chunk.toString();
            // Support multiple newline-delimited JSON messages
            let newlineIdx;
            while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
                const line = buffer.slice(0, newlineIdx).trim();
                buffer = buffer.slice(newlineIdx + 1);
                if (!line)
                    continue;
                try {
                    const msg = JSON.parse(line);
                    this.handleIpcMessage(msg, socket);
                }
                catch (err) {
                    process.stderr.write(`[channel-sdk] Invalid IPC message: ${err}\n`);
                }
            }
        });
        socket.on("error", (err) => {
            process.stderr.write(`[channel-sdk] IPC socket error: ${err.message}\n`);
        });
    }
    async handleIpcMessage(msg, socket) {
        switch (msg.type) {
            case "hook_event":
                await this.handleHookEvent(msg, socket);
                break;
            case "permission_verdict":
                await this.sendPermissionVerdict({
                    request_id: msg.request_id,
                    behavior: msg.behavior,
                });
                break;
            case "chat_message":
                await this.pushMessage(msg.content, {
                    chat_id: msg.chat_id,
                    ...(msg.meta ?? {}),
                });
                break;
        }
    }
    async handleHookEvent(msg, socket) {
        const input = msg.input;
        // Emit to listeners
        this.emit("hookEvent", input);
        // Call handler
        let response = {};
        if (this.hookHandler) {
            const result = await this.hookHandler(input);
            if (result)
                response = result;
        }
        if (msg.blocking && BLOCKING_EVENTS.has(input.hook_event_name)) {
            // For blocking hooks, wait for client decision or use handler response
            if (Object.keys(response).length > 0) {
                // Handler already provided a response
                this.sendIpcResponse(socket, msg.id, response);
            }
            else {
                // Wait for client to provide response via resolveHook()
                const timer = setTimeout(() => {
                    this.pendingHooks.delete(msg.id);
                    this.sendIpcResponse(socket, msg.id, {});
                }, this.options.blockingTimeout);
                this.pendingHooks.set(msg.id, {
                    resolve: (resp) => this.sendIpcResponse(socket, msg.id, resp),
                    timer,
                });
            }
        }
        else {
            // Non-blocking: respond immediately
            this.sendIpcResponse(socket, msg.id, response);
        }
    }
    sendIpcResponse(socket, id, response) {
        const resp = { id, response };
        try {
            socket.write(JSON.stringify(resp) + "\n");
        }
        catch {
            // Socket may have closed
        }
    }
}
//# sourceMappingURL=channel-server.js.map