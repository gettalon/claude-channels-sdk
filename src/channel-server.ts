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
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createServer as createNetServer, type Server as NetServer, type Socket } from "node:net";
import { unlinkSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { EventEmitter } from "node:events";

import type {
  ChannelServerOptions,
  ChannelPermissionRequest,
  ChannelPermissionVerdict,
  HookEventInput,
  HookResponse,
  HookIpcMessage,
  HookIpcResponse,
  IpcInbound,
  HookEventHandler,
  PermissionRequestHandler,
  ChatReplyHandler,
  ToolCallHandler,
  HookEventName,
} from "./types.js";
import { BLOCKING_EVENTS } from "./types.js";

const DEFAULT_SOCKET_PATH_SUFFIX = "channel-hooks.sock";
const DEFAULT_BLOCKING_TIMEOUT = 30_000;

// ─── ChannelServer ──────────────────────────────────────────────────────────

export class ChannelServer extends EventEmitter {
  private mcpServer: Server;
  private ipcServer: NetServer | null = null;
  private socketPath: string;
  private options: Required<
    Pick<ChannelServerOptions, "name" | "version" | "instructions" | "permissionRelay" | "blockingTimeout">
  > & ChannelServerOptions;

  // Pending blocking hook responses: hook script waiting for client decision
  private pendingHooks = new Map<string, {
    resolve: (resp: HookResponse) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  // Event handlers
  private hookHandler: HookEventHandler | null = null;
  private permissionHandler: PermissionRequestHandler | null = null;
  private replyHandler: ChatReplyHandler | null = null;
  private toolHandler: ToolCallHandler | null = null;

  constructor(opts: ChannelServerOptions) {
    super();
    this.options = {
      permissionRelay: true,
      blockingTimeout: DEFAULT_BLOCKING_TIMEOUT,
      ...opts,
    };

    this.socketPath = opts.socketPath ?? this.defaultSocketPath();

    // Build MCP capabilities
    const experimental: Record<string, object> = { "claude/channel": {} };
    if (this.options.permissionRelay) {
      experimental["claude/channel/permission"] = {};
    }

    this.mcpServer = new Server(
      { name: opts.name, version: opts.version },
      {
        capabilities: { experimental, tools: {} },
        instructions: opts.instructions,
      },
    );

    this.setupTools();
    if (this.options.permissionRelay) {
      this.setupPermissionRelay();
    }
  }

  /** The underlying MCP Server instance */
  get mcp(): Server {
    return this.mcpServer;
  }

  // ─── Public API ──────────────────────────────────────────────────────────

  /** Start IPC socket + connect MCP over stdio */
  async start(): Promise<void> {
    await this.startIpcServer();
    const transport = new StdioServerTransport();
    await this.mcpServer.connect(transport);
    this.emit("ready");
    process.stderr.write(`[channel-sdk] Ready (socket: ${this.socketPath})\n`);
  }

  /** Push a message into Claude's session via channel notification */
  async pushMessage(content: string, meta?: Record<string, string>): Promise<void> {
    await this.mcpServer.notification({
      method: "notifications/claude/channel",
      params: { content, ...(meta ? { meta } : {}) },
    });
  }

  /** Send a permission verdict back to Claude Code */
  async sendPermissionVerdict(verdict: ChannelPermissionVerdict): Promise<void> {
    await this.mcpServer.notification({
      method: "notifications/claude/channel/permission" as any,
      params: verdict as any,
    });
  }

  /** Resolve a pending blocking hook with a response */
  resolveHook(id: string, response: HookResponse): void {
    const pending = this.pendingHooks.get(id);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingHooks.delete(id);
      pending.resolve(response);
    }
  }

  /** Register handler for all hook events */
  onHookEvent(handler: HookEventHandler): void {
    this.hookHandler = handler;
  }

  /** Register handler for permission relay requests */
  onPermissionRequest(handler: PermissionRequestHandler): void {
    this.permissionHandler = handler;
  }

  /** Register handler for Claude's reply tool calls */
  onReply(handler: ChatReplyHandler): void {
    this.replyHandler = handler;
  }

  /** Register handler for extra tool calls */
  onToolCall(handler: ToolCallHandler): void {
    this.toolHandler = handler;
  }

  /** Get the Unix socket path for hook scripts to connect to */
  getSocketPath(): string {
    return this.socketPath;
  }

  /** Generate the settings.json hooks configuration for all events */
  generateHooksConfig(hookScriptPath: string): Record<string, unknown> {
    const allEvents: HookEventName[] = this.options.enabledHooks ?? [
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

    const hooks: Record<string, unknown> = {};
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
  cleanup(): void {
    try {
      if (this.ipcServer) this.ipcServer.close();
      if (existsSync(this.socketPath)) unlinkSync(this.socketPath);
    } catch {}
  }

  // ─── MCP Tools ──────────────────────────────────────────────────────────

  private setupTools(): void {
    const extraTools = this.options.extraTools ?? [];

    this.mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "reply",
          description: "Send a reply message back through the channel",
          inputSchema: {
            type: "object" as const,
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
        const { chat_id, text } = args as { chat_id: string; text: string };
        if (this.replyHandler) this.replyHandler(chat_id, text);
        this.emit("reply", chat_id, text);
        return { content: [{ type: "text" as const, text: "sent" }] };
      }

      // Extra tools
      if (this.toolHandler) {
        const result = await this.toolHandler(name, (args ?? {}) as Record<string, unknown>);
        if (typeof result === "string") {
          return { content: [{ type: "text" as const, text: result }] };
        }
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      }

      throw new Error(`Unknown tool: ${name}`);
    });
  }

  // ─── Permission Relay ────────────────────────────────────────────────────

  private setupPermissionRelay(): void {
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
      const request: ChannelPermissionRequest = params;
      process.stderr.write(`[channel-sdk] Permission request: ${params.tool_name} (${params.request_id})\n`);
      if (this.permissionHandler) this.permissionHandler(request);
      this.emit("permissionRequest", request);
    });
  }

  // ─── IPC Server (Unix Socket) ────────────────────────────────────────────

  private defaultSocketPath(): string {
    const home = process.env.HOME ?? "/tmp";
    return `${home}/.claude/${DEFAULT_SOCKET_PATH_SUFFIX}`;
  }

  private async startIpcServer(): Promise<void> {
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

  private handleIpcConnection(socket: Socket): void {
    let buffer = "";

    socket.on("data", (chunk) => {
      buffer += chunk.toString();

      // Support multiple newline-delimited JSON messages
      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);
        if (!line) continue;

        try {
          const msg: IpcInbound = JSON.parse(line);
          this.handleIpcMessage(msg, socket);
        } catch (err) {
          process.stderr.write(`[channel-sdk] Invalid IPC message: ${err}\n`);
        }
      }
    });

    socket.on("error", (err) => {
      process.stderr.write(`[channel-sdk] IPC socket error: ${err.message}\n`);
    });
  }

  private async handleIpcMessage(msg: IpcInbound, socket: Socket): Promise<void> {
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

  private async handleHookEvent(msg: HookIpcMessage, socket: Socket): Promise<void> {
    const input = msg.input;

    // Emit to listeners
    this.emit("hookEvent", input);

    // Call handler
    let response: HookResponse = {};
    if (this.hookHandler) {
      const result = await this.hookHandler(input);
      if (result) response = result;
    }

    if (msg.blocking && BLOCKING_EVENTS.has(input.hook_event_name)) {
      // For blocking hooks, wait for client decision or use handler response
      if (Object.keys(response).length > 0) {
        // Handler already provided a response
        this.sendIpcResponse(socket, msg.id, response);
      } else {
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
    } else {
      // Non-blocking: respond immediately
      this.sendIpcResponse(socket, msg.id, response);
    }
  }

  private sendIpcResponse(socket: Socket, id: string, response: HookResponse): void {
    const resp: HookIpcResponse = { id, response };
    try {
      socket.write(JSON.stringify(resp) + "\n");
    } catch {
      // Socket may have closed
    }
  }
}
