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
import { Socket as NetSocket } from "node:net";
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
  AccessState,
  AccessPolicy,
  PendingPairing,
  AccessControlOptions,
  AccessMode,
} from "./types.js";
import { BLOCKING_EVENTS } from "./types.js";
import { readFile, writeFile, mkdir } from "node:fs/promises";

const DEFAULT_SOCKET_PATH_SUFFIX = "channel-hooks.sock";
const DEFAULT_BLOCKING_TIMEOUT = 30_000;

// ─── SocketTransport (MCP Transport over Unix socket) ───────────────────────

/**
 * Custom MCP transport that wraps a Unix domain socket.
 * Messages are newline-delimited JSON-RPC.
 */
class SocketTransport {
  private socket: Socket;
  private buffer = "";

  onmessage?: (message: any) => void;
  onerror?: (error: Error) => void;
  onclose?: () => void;

  constructor(socket: Socket) {
    this.socket = socket;

    socket.on("data", (chunk) => {
      this.buffer += chunk.toString();
      let idx: number;
      while ((idx = this.buffer.indexOf("\n")) !== -1) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          this.onmessage?.(msg);
        } catch (err) {
          this.onerror?.(err instanceof Error ? err : new Error(String(err)));
        }
      }
    });

    socket.on("close", () => this.onclose?.());
    socket.on("error", (err) => this.onerror?.(err));
  }

  async start(): Promise<void> {
    // Socket is already connected
  }

  async send(message: any): Promise<void> {
    this.socket.write(JSON.stringify(message) + "\n");
  }

  async close(): Promise<void> {
    this.socket.end();
  }
}

// ─── Session ───────────────────────────────────────────────────────────────

interface Session {
  id: string;
  server: Server;
  connected: boolean;
}

// ─── ChannelServer ──────────────────────────────────────────────────────────

export class ChannelServer extends EventEmitter {
  private sessions = new Map<string, Session>();
  private primarySessionId: string | null = null;
  private sessionServer: NetServer | null = null;
  private ipcServer: NetServer | null = null;
  private socketPath: string;
  private sessionSocketPath: string;
  private options: Required<
    Pick<ChannelServerOptions, "name" | "version" | "instructions" | "permissionRelay" | "blockingTimeout">
  > & Pick<ChannelServerOptions, "agentName"> & ChannelServerOptions;

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

  // Access control
  private accessState: AccessState;
  private accessPath: string;
  private accessOpts: Required<AccessControlOptions>;

  constructor(opts: ChannelServerOptions) {
    super();
    this.options = {
      permissionRelay: true,
      blockingTimeout: DEFAULT_BLOCKING_TIMEOUT,
      ...opts,
    };

    this.socketPath = opts.socketPath ?? this.defaultSocketPath();
    this.sessionSocketPath = this.socketPath.replace(/\.sock$/, "-sessions.sock");

    // Access control
    const home = process.env.HOME ?? "/tmp";
    this.accessOpts = {
      accessPath: opts.accessControl?.accessPath ?? `${home}/.claude/channels/access.json`,
      defaultMode: opts.accessControl?.defaultMode ?? "pairing",
      autoApproveFirst: opts.accessControl?.autoApproveFirst ?? true,
      codeLength: opts.accessControl?.codeLength ?? 6,
    };
    this.accessPath = this.accessOpts.accessPath;
    this.accessState = {
      default: { mode: this.accessOpts.defaultMode, allowed: [], admins: [] },
      pending: {},
    };
  }

  // ─── Health & Heartbeat ──────────────────────────────────────────────────

  /** Get health status of the channel server */
  health(): {
    status: "ok" | "degraded" | "down";
    sessions: number;
    uptime: number;
    pendingHooks: number;
    pendingPairings: number;
    access: { mode: string; approved: number; admins: number };
  } {
    const sessions = Array.from(this.sessions.values()).filter((s) => s.connected).length;
    return {
      status: sessions > 0 ? "ok" : "down",
      sessions,
      uptime: process.uptime(),
      pendingHooks: this.pendingHooks.size,
      pendingPairings: Object.keys(this.accessState.pending).length,
      access: {
        mode: this.accessState.default.mode,
        approved: this.accessState.default.allowed.length,
        admins: this.accessState.default.admins.length,
      },
    };
  }

  /** Get the primary session's MCP Server (backward compat) */
  get mcp(): Server {
    if (this.primarySessionId) {
      return this.sessions.get(this.primarySessionId)!.server;
    }
    // Return first session if no primary
    const first = this.sessions.values().next().value;
    if (first) return first.server;
    throw new Error("No sessions connected");
  }

  /** Get all session IDs */
  getSessionIds(): string[] {
    return Array.from(this.sessions.keys());
  }

  /** Get session count */
  get sessionCount(): number {
    return this.sessions.size;
  }

  /** Get or set the agent display name */
  get agentName(): string | undefined {
    return this.options.agentName;
  }
  set agentName(name: string | undefined) {
    this.options.agentName = name;
  }

  // ─── Private: Create MCP Server for a session ─────────────────────────────

  private createSessionServer(): Server {
    const experimental: Record<string, object> = { "claude/channel": {} };
    if (this.options.permissionRelay) {
      experimental["claude/channel/permission"] = {};
    }

    const server = new Server(
      { name: this.options.name, version: this.options.version },
      {
        capabilities: { experimental, tools: {} },
        instructions: this.options.agentName
          ? `Your agent name is "${this.options.agentName}". ${this.options.instructions}`
          : this.options.instructions,
      },
    );

    this.setupToolsForServer(server);
    if (this.options.permissionRelay) {
      this.setupPermissionRelayForServer(server);
    }

    return server;
  }

  private genSessionId(): string {
    return `session-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  }

  // ─── Public API ──────────────────────────────────────────────────────────

  /** Start IPC socket + connect MCP session over stdio.
   *  If another instance is already running (IPC socket exists), connects
   *  as a secondary session via the session socket instead of starting fresh. */
  async start(): Promise<void> {
    // Check if another instance is already running
    if (existsSync(this.sessionSocketPath)) {
      const isAlive = await this.probeSessionSocket();
      if (isAlive) {
        process.stderr.write(`[channel-sdk] Another instance detected — joining as secondary session\n`);
        await this.startAsSecondary();
        return;
      }
      // Stale socket — clean up and start as primary
      process.stderr.write(`[channel-sdk] Stale session socket found — starting as primary\n`);
    }

    await this.startIpcServer();
    await this.startSessionServer();

    // Primary session over stdio
    const sessionId = this.genSessionId();
    const server = this.createSessionServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    this.sessions.set(sessionId, { id: sessionId, server, connected: true });
    this.primarySessionId = sessionId;

    this.emit("ready");
    this.emit("sessionConnected", sessionId);
    process.stderr.write(`[channel-sdk] Ready — primary session: ${sessionId} (socket: ${this.socketPath})\n`);
    process.stderr.write(`[channel-sdk] Session socket: ${this.sessionSocketPath} (for additional Claude sessions)\n`);
  }

  /** Probe the session socket to check if a primary instance is alive */
  private probeSessionSocket(): Promise<boolean> {
    return new Promise((resolve) => {
      const sock = new NetSocket();
      sock.once("connect", () => {
        sock.destroy();
        resolve(true);
      });
      sock.once("error", () => {
        sock.destroy();
        resolve(false);
      });
      setTimeout(() => {
        sock.destroy();
        resolve(false);
      }, 1000);
      sock.connect(this.sessionSocketPath);
    });
  }

  /** Start as a secondary instance — connect stdio MCP through the session socket to the primary */
  private async startAsSecondary(): Promise<void> {
    // Connect to the primary's session socket
    const sock = new NetSocket();

    await new Promise<void>((resolve, reject) => {
      sock.once("connect", () => resolve());
      sock.once("error", (err: Error) => reject(err));
      sock.connect(this.sessionSocketPath);
    });

    process.stderr.write(`[channel-sdk] Connected to primary via session socket\n`);

    // Bridge: stdio ↔ session socket
    // Claude Code sends JSON-RPC over stdin, we forward to the session socket
    // Primary responds via socket, we forward to stdout
    process.stdin.on("data", (chunk: Buffer) => {
      sock.write(chunk);
    });

    sock.on("data", (chunk: Buffer) => {
      process.stdout.write(chunk);
    });

    sock.on("close", () => {
      process.stderr.write(`[channel-sdk] Primary disconnected — exiting\n`);
      process.exit(0);
    });

    process.stdin.on("end", () => {
      sock.end();
    });

    this.emit("ready");
    process.stderr.write(`[channel-sdk] Secondary session ready (proxying to primary)\n`);
  }

  /** Push a message into Claude's session(s) via channel notification */
  async pushMessage(content: string, meta?: Record<string, string>, sessionId?: string): Promise<void> {
    // Inject agent_name into meta if configured
    const finalMeta = this.options.agentName
      ? { agent_name: this.options.agentName, ...(meta ?? {}) }
      : meta;
    const notification = {
      method: "notifications/claude/channel" as const,
      params: { content, ...(finalMeta ? { meta: finalMeta } : {}) },
    };

    if (sessionId) {
      // Target specific session
      const session = this.sessions.get(sessionId);
      if (session?.connected) {
        await session.server.notification(notification);
      }
    } else {
      // Broadcast to all sessions
      const errors: string[] = [];
      for (const session of this.sessions.values()) {
        if (!session.connected) continue;
        try {
          await session.server.notification(notification);
        } catch (err) {
          errors.push(`${session.id}: ${err}`);
        }
      }
      if (errors.length > 0) {
        process.stderr.write(`[channel-sdk] pushMessage errors: ${errors.join("; ")}\n`);
      }
    }
  }

  /** Send a permission verdict back to Claude Code */
  async sendPermissionVerdict(verdict: ChannelPermissionVerdict, sessionId?: string): Promise<void> {
    const notification = {
      method: "notifications/claude/channel/permission" as any,
      params: verdict as any,
    };

    if (sessionId) {
      const session = this.sessions.get(sessionId);
      if (session?.connected) {
        await session.server.notification(notification);
      }
    } else {
      // Send to all sessions
      for (const session of this.sessions.values()) {
        if (!session.connected) continue;
        try {
          await session.server.notification(notification);
        } catch {}
      }
    }
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

  // ─── Access Control / Pairing ─────────────────────────────────────────────

  /** Load access state from disk */
  async loadAccess(): Promise<void> {
    try {
      const raw = await readFile(this.accessPath, "utf-8");
      const parsed = JSON.parse(raw) as AccessState;
      if (parsed.default) this.accessState = parsed;
    } catch {
      // File doesn't exist yet — use defaults
    }
  }

  /** Save access state to disk */
  async saveAccess(): Promise<void> {
    try {
      await mkdir(dirname(this.accessPath), { recursive: true });
      await writeFile(this.accessPath, JSON.stringify(this.accessState, null, 2));
    } catch (err) {
      process.stderr.write(`[channel-sdk] Failed to save access: ${err}\n`);
    }
  }

  /** Get current access state (read-only copy) */
  getAccessState(): AccessState {
    return JSON.parse(JSON.stringify(this.accessState));
  }

  /** Check if an identity is allowed */
  isAllowed(identity: string): boolean {
    const policy = this.accessState.default;
    if (policy.mode === "open") return true;
    if (policy.mode === "disabled") return false;
    return policy.allowed.includes(identity) || policy.admins.includes(identity);
  }

  /** Check if an identity is an admin */
  isAdmin(identity: string): boolean {
    return this.accessState.default.admins.includes(identity);
  }

  /**
   * Request pairing for an unknown identity.
   * Returns the pairing code if a new request was created,
   * or the existing code if already pending.
   */
  async requestPairing(
    identity: string,
    displayName: string,
    chatId: string,
    channel: string,
    metadata?: Record<string, unknown>,
  ): Promise<{ code: string; isNew: boolean; autoApproved?: boolean }> {
    // Auto-approve first connection as admin
    if (
      this.accessOpts.autoApproveFirst &&
      this.accessState.default.admins.length === 0 &&
      this.accessState.default.allowed.length === 0
    ) {
      this.accessState.default.admins.push(identity);
      this.accessState.default.allowed.push(identity);
      await this.saveAccess();
      this.emit("pairingApproved", { identity, displayName, channel, autoApproved: true });
      process.stderr.write(`[channel-sdk] Auto-approved first connection as admin: ${displayName} (${identity})\n`);
      return { code: "", isNew: false, autoApproved: true };
    }

    // Check if already pending
    const existing = Object.values(this.accessState.pending).find((p) => p.identity === identity);
    if (existing) {
      return { code: existing.code, isNew: false };
    }

    // Generate pairing code
    const code = this.generateCode(this.accessOpts.codeLength);
    const pairingId = `${identity}-${Date.now()}`;
    this.accessState.pending[pairingId] = {
      code,
      identity,
      displayName,
      chatId,
      channel,
      ts: Date.now(),
      metadata,
    };
    await this.saveAccess();

    this.emit("pairingRequested", { pairingId, code, identity, displayName, channel });
    process.stderr.write(`[channel-sdk] Pairing requested: ${displayName} (${identity}) code=${code}\n`);
    return { code, isNew: true };
  }

  /**
   * Approve a pending pairing by code.
   * Returns the approved identity or null if not found.
   */
  async approve(code: string, asAdmin = false): Promise<PendingPairing | null> {
    const entry = Object.entries(this.accessState.pending).find(([, p]) => p.code === code);
    if (!entry) return null;

    const [pairingId, pairing] = entry;
    delete this.accessState.pending[pairingId];

    if (!this.accessState.default.allowed.includes(pairing.identity)) {
      this.accessState.default.allowed.push(pairing.identity);
    }
    if (asAdmin && !this.accessState.default.admins.includes(pairing.identity)) {
      this.accessState.default.admins.push(pairing.identity);
    }

    await this.saveAccess();
    this.emit("pairingApproved", { ...pairing, asAdmin });
    process.stderr.write(`[channel-sdk] Approved: ${pairing.displayName} (${pairing.identity})${asAdmin ? " [admin]" : ""}\n`);
    return pairing;
  }

  /** Revoke access for an identity */
  async revoke(identity: string): Promise<boolean> {
    const policy = this.accessState.default;
    const wasAllowed = policy.allowed.includes(identity);
    policy.allowed = policy.allowed.filter((id) => id !== identity);
    policy.admins = policy.admins.filter((id) => id !== identity);
    if (wasAllowed) {
      await this.saveAccess();
      this.emit("accessRevoked", { identity });
    }
    return wasAllowed;
  }

  /** Set access mode */
  async setAccessMode(mode: AccessMode): Promise<void> {
    this.accessState.default.mode = mode;
    await this.saveAccess();
  }

  /** List pending pairings */
  getPendingPairings(): PendingPairing[] {
    return Object.values(this.accessState.pending);
  }

  private generateCode(length: number): string {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous chars
    let code = "";
    for (let i = 0; i < length; i++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
    return code;
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

  /** Clean up socket files on shutdown */
  cleanup(): void {
    try {
      if (this.ipcServer) this.ipcServer.close();
      if (this.sessionServer) this.sessionServer.close();
      if (existsSync(this.socketPath)) unlinkSync(this.socketPath);
      if (existsSync(this.sessionSocketPath)) unlinkSync(this.sessionSocketPath);
    } catch {}
  }

  // ─── MCP Tools (per-session setup) ──────────────────────────────────────

  private setupToolsForServer(server: Server): void {
    const extraTools = this.options.extraTools ?? [];

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
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

    server.setRequestHandler(CallToolRequestSchema, async (req) => {
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

  // ─── Permission Relay (per-session setup) ─────────────────────────────────

  private setupPermissionRelayForServer(server: Server): void {
    const PermissionRequestSchema = z.object({
      method: z.literal("notifications/claude/channel/permission_request"),
      params: z.object({
        request_id: z.string(),
        tool_name: z.string(),
        description: z.string(),
        input_preview: z.string(),
      }),
    });

    server.setNotificationHandler(PermissionRequestSchema, async ({ params }) => {
      const request: ChannelPermissionRequest = params;
      process.stderr.write(`[channel-sdk] Permission request: ${params.tool_name} (${params.request_id})\n`);
      if (this.permissionHandler) this.permissionHandler(request);
      this.emit("permissionRequest", request);
    });
  }

  // ─── Session Socket (additional Claude sessions connect here) ─────────────

  private async startSessionServer(): Promise<void> {
    // Remove stale socket
    if (existsSync(this.sessionSocketPath)) {
      unlinkSync(this.sessionSocketPath);
    }

    return new Promise((resolve) => {
      this.sessionServer = createNetServer((socket) => this.handleSessionConnection(socket));

      this.sessionServer.on("error", (err) => {
        process.stderr.write(`[channel-sdk] Session server error: ${err.message}\n`);
      });

      this.sessionServer.listen(this.sessionSocketPath, () => {
        process.stderr.write(`[channel-sdk] Session server listening on ${this.sessionSocketPath}\n`);
        resolve();
      });
    });
  }

  private async handleSessionConnection(socket: Socket): Promise<void> {
    const sessionId = this.genSessionId();
    const server = this.createSessionServer();

    // Custom Transport wrapping Unix socket (newline-delimited JSON-RPC)
    const transport = new SocketTransport(socket);
    await server.connect(transport);

    const session: Session = { id: sessionId, server, connected: true };
    this.sessions.set(sessionId, session);

    process.stderr.write(`[channel-sdk] New session connected: ${sessionId}\n`);
    this.emit("sessionConnected", sessionId);

    socket.on("close", () => {
      session.connected = false;
      this.sessions.delete(sessionId);
      process.stderr.write(`[channel-sdk] Session disconnected: ${sessionId}\n`);
      this.emit("sessionDisconnected", sessionId);
    });

    socket.on("error", (err) => {
      process.stderr.write(`[channel-sdk] Session socket error (${sessionId}): ${err.message}\n`);
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
