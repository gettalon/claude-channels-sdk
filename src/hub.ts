/**
 * ChannelHub — Core connection manager for the edge agent protocol.
 *
 * Handles: agent registration + dedup, message routing, heartbeat,
 * connection lifecycle, settings management, server management.
 *
 * The talon MCP server is just a thin wrapper around this.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { createHash } from "node:crypto";
import { join, basename } from "node:path";
import { EventEmitter } from "node:events";
import type { AgentToolDef, SessionEnvelope, RecipientFilter } from "./protocol.js";
import { loadAgentConfig, saveAgentConfig, listAgentConfigs } from "./agent-config.js";
import { getTalonHome } from "./hub-settings.js";
import type { AgentConfig } from "./types.js";

let _machineId: string | null = null;
async function getMachineId(): Promise<string> {
  if (_machineId) return _machineId;
  const idPath = join(homedir(), ".talon", "machine-id");
  try {
    _machineId = (await readFile(idPath, "utf-8")).trim();
  } catch {
    _machineId = createHash("md5").update(hostname() + Date.now()).digest("hex").slice(0, 8);
    await mkdir(join(homedir(), ".talon"), { recursive: true });
    await writeFile(idPath, _machineId);
  }
  return _machineId;
}
export function randomAgentName(): string { return `agent-${_machineId ?? crypto.randomUUID().slice(0, 8)}-${Math.random().toString(36).slice(2, 6)}`; }
/** Ensure machine ID is loaded before generating agent names. Call early in startup. */
export async function ensureMachineId(): Promise<void> { await getMachineId(); }

// ── Types ──────────────────────────────────────────────────────────────────

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
export type HubHookEvent =
  | "postSetup"
  | "onServerStart"
  | "onAgentConnect"
  | "onAgentDisconnect"
  | "onMessage"
  | "onReload";

/** A programmatic hook function */
export type HubHookFn = (...args: any[]) => Promise<void>;

/** A shell command hook — executed via child_process.exec */
export interface ShellCommandHook {
  event: HubHookEvent;
  command: string;
}

/** A channel endpoint associated with a contact (e.g. telegram chat, WS agent). */
export interface ContactChannel {
  type: string;   // e.g. "telegram", "websocket", "discord"
  id: string;     // channel-specific identifier (chat_id, agent_id, etc.)
  url: string;    // connection URL used by the channel
}

/** A named contact entry for human-friendly name resolution. */
export interface ContactEntry {
  name: string;
  channels: ContactChannel[];
}

export interface HubSettings {
  servers?: Array<{ url: string; name?: string; port?: number; pid?: number; startedAt?: string }>;
  connections?: Array<{ url: string; name?: string; transport?: string; connectedAt?: string; config?: Record<string, unknown>; remoteInfo?: { server_name?: string; agents?: Array<{ id: string; name: string; tools?: string[] }>; groups?: Array<{ name: string; members: string[] }>; chat_routes?: Record<string, { agentName?: string }>; cachedAt?: string } }>;
  transports?: Record<string, Record<string, unknown> | Array<Record<string, unknown>>>;
  access?: {
    allowlist?: string[];
    denylist?: string[];
    requireApproval?: boolean;
  };
  hooks?: Array<{ event: string; command: string }>;
  contacts?: Record<string, { name: string; channels: Array<{ type: string; id: string; url: string }> }>;
  state?: {
    chatRoutes?: Record<string, { agentName: string; channel?: string; channelUrl?: string }>;
    groups?: Record<string, string[]>;
    targets?: Record<string, { name: string; channelType: string; rawId: string; kind: string }>;
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

// ── Settings (delegated to hub-settings.ts) ──────────────────────────────
export { setSettingsPath } from "./hub-settings.js";
import { installSettings } from "./hub-settings.js";
import { installHooks } from "./hub-hooks.js";
import { installUpdate } from "./hub-update.js";
import { installHealth } from "./hub-health.js";
import { installContacts } from "./hub-contacts.js";
import { installRouting } from "./hub-routing.js";
import { installClient } from "./hub-client.js";
import { installServer } from "./hub-server.js";
import { installCommands } from "./hub-commands.js";
import type { CommandDef, CommandResult } from "./hub-commands.js";

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

// ── ChannelHub ─────────────────────────────────────────────────────────────

export interface HealthSnapshot {
  servers: Array<{ id: string; healthy: boolean; port?: number }>;
  clients: Array<{ url: string; healthy: boolean; channel: string }>;
  agents: { total: number; stale: number };
  uptime: number;
}

type ClientEntry = {
  id: string;
  url: string;
  channelId: string;
  transport: string;
  role: "server" | "channel" | "relay";
  ws: any;
  name: string;
  heartbeatTimer?: ReturnType<typeof setInterval>;
};

export class ChannelHub extends EventEmitter {
  readonly name: string;
  readonly defaultPort: number;
  readonly agents = new Map<string, AgentState>();
  readonly servers = new Map<string, { type: string; port?: number; httpServer?: any; wss?: any }>();
  readonly clients = new Map<string, ClientEntry>();
  readonly pendingCalls = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  readonly pendingAgents = new Map<string, PendingAgent>();
  readonly chatRoutes = new Map<string, string>();
  readonly channelForChat = new Map<string, ClientEntry>();
  /** Unified target registry: uuid -> TargetEntry. Each (channel, entity) pair has one UUID. */
  readonly targetRegistry = new Map<string, TargetEntry>();
  /** Name -> UUID lookup for fast resolution. */
  readonly targetNameIndex = new Map<string, string>();
  readonly groups = new Map<string, Map<string, GroupMember>>();
  readonly contacts = new Map<string, ContactEntry>();
  readonly startedAt: number;

  private callIdCounter = 0;
  private proxyIdCounter = 0;
  private opts: HubOptions;
  private clientTools: AgentToolDef[];
  private readonly hookRegistry = new Map<string, HubHookFn[]>();
  private shellHooks: ShellCommandHook[] = [];
  private healthMonitorTimer: ReturnType<typeof setInterval> | null = null;
  private lastPersistedStateJson = "";
  private readonly agentConfigDir: string;
  private readonly pendingProxyCalls = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private fileWatcher: any = null;
  readonly peerKeys = new Map<string, string>();
  /** E2E encryption sessions per agent. Key = agent name, value = E2eSession. */
  readonly e2eSessions = new Map<string, import("./mesh.js").E2eSession>();
  /** Hub identity keypair — loaded lazily on first key exchange. */
  private _identity: import("./mesh.js").IdentityStore | null = null;

  /** Messages buffered for offline agents. Key = agent name, value = queued messages (max 100 per agent). */
  private readonly messageBuffer = new Map<string, Array<{ content: string; from: string; rich?: import("./protocol.js").RichMessageParams }>>();
  private static readonly MAX_BUFFERED_MESSAGES = 100;

  /** Seen msgIds for flood deduplication. Key = msgId, value = timestamp (ms). */
  readonly seenMessages = new Map<string, number>();
  private static readonly SEEN_MSG_TTL_MS = 5 * 60 * 1000;

  /** Returns true if this msgId was already seen (dedup check). Adds to seen-set if new. */
  seenOrTrack(msgId: string): boolean {
    if (this.seenMessages.has(msgId)) return true;
    this.seenMessages.set(msgId, Date.now());
    return false;
  }

  /** Evict expired seen message IDs (called periodically by the server). */
  evictSeenMessages(): void {
    const cutoff = Date.now() - ChannelHub.SEEN_MSG_TTL_MS;
    for (const [id, ts] of this.seenMessages) {
      if (ts < cutoff) this.seenMessages.delete(id);
    }
  }

  constructor(opts: HubOptions = {}) {
    super();
    this.startedAt = Date.now();
    this.opts = opts;
    this.name = opts.name ?? process.env.TALON_AGENT_NAME ?? "talon";
    this.defaultPort = opts.port ?? (process.env.TALON_PORT ? parseInt(process.env.TALON_PORT, 10) : 9090);
    this.clientTools = opts.clientTools ?? [];
    (this as any)._hooksEnabled = opts.hooksEnabled !== false;
    this.agentConfigDir = opts.agentConfigDir ?? join(getTalonHome(), "agents");
    // Register programmatic hooks provided via options
    if (opts.hooks) {
      for (const [event, fns] of Object.entries(opts.hooks)) {
        for (const fn of fns) {
          this.hook(event as HubHookEvent, fn);
        }
      }
    }
  }

  // ── Message buffering for offline agents ──────────────────────────────

  /**
   * Buffer a message for an agent that is currently offline.
   * Messages are capped at MAX_BUFFERED_MESSAGES per agent.
   */
  bufferMessage(agentName: string, content: string, from: string, rich?: import("./protocol.js").RichMessageParams): void {
    let queue = this.messageBuffer.get(agentName);
    if (!queue) {
      queue = [];
      this.messageBuffer.set(agentName, queue);
    }
    if (queue.length >= ChannelHub.MAX_BUFFERED_MESSAGES) {
      queue.shift(); // drop oldest
    }
    queue.push({ content, from, rich });
    process.stderr.write(`[${this.name}] Buffered message for offline agent "${agentName}" (${queue.length} queued)\n`);
  }

  /**
   * Flush all buffered messages for an agent that just connected.
   * Sends each message via the agent's WebSocket.
   */
  flushBufferedMessages(agentName: string): void {
    const queue = this.messageBuffer.get(agentName);
    if (!queue || queue.length === 0) return;
    const agent = this.findAgent(agentName);
    if (!agent) return;
    const count = queue.length;
    process.stderr.write(`[${this.name}] Flushing ${count} buffered message(s) to "${agentName}"\n`);
    // Notify the agent about buffered messages before delivering them
    this.wsSend(agent.ws, { type: "chat", chat_id: agent.id, content: `You have ${count} buffered message${count === 1 ? "" : "s"}`, from: "system" });
    for (const msg of queue) {
      this.wsSend(agent.ws, { type: "chat", chat_id: agent.id, content: msg.content, from: msg.from, ...msg.rich });
    }
    this.messageBuffer.delete(agentName);
  }

  // ── Version & Auto-Update (delegated to hub-update.ts) ────────────────
  static getVersion: () => string;
  declare checkForUpdates: () => Promise<UpdateInfo>;
  declare autoUpdate: () => Promise<UpdateInfo & { updated: boolean }>;

  // ── Hooks (delegated to hub-hooks.ts) ───────────────────────────────────
  declare hook: (event: HubHookEvent, fn: HubHookFn) => this;
  declare addShellHook: (event: HubHookEvent, command: string) => Promise<void>;
  /** @internal */ declare loadShellHooks: () => Promise<void>;
  /** @internal */ declare fireHooks: (event: HubHookEvent, ...args: any[]) => Promise<void>;
  /** @internal */ declare execShellHook: (command: string, event: string, args: any[]) => Promise<void>;

  // ── Commands (delegated to hub-commands.ts) ─────────────────────────────
  declare registerCommand: (def: CommandDef) => void;
  declare executeCommand: (text: string, context?: { chatId?: string; user?: string }) => Promise<CommandResult | null>;
  declare listCommands: () => CommandDef[];

  // ── Getters ────────────────────────────────────────────────────────────

  serverRunning(): boolean { return this.servers.size > 0; }
  /** True if connected to a remote server (WS/Unix) — not counting channel connections (Telegram, etc.) */
  clientConnected(): boolean { return [...this.clients.values()].some(c => c.role === "server"); }
  /** Get first server connection WS */
  getClientWs(): any { const srv = [...this.clients.values()].find(c => c.role === "server"); return srv?.ws ?? null; }
  /** All connected channels (including server connections) */
  allChannels(): ClientEntry[] { return [...this.clients.values()]; }
  /** Only channel connections (Telegram, Discord, etc. — not server) */
  channelConnections(): ClientEntry[] { return [...this.clients.values()].filter(c => c.role === "channel"); }
  /** True when this instance is a client (connected to a remote server, not running its own server). */
  isClient(): boolean { return !this.serverRunning() && this.clientConnected(); }

  // ── Proxy to server (client-side) ──────────────────────────────────────

  /**
   * Send a proxy_command to the server and wait for the result.
   * Used by client instances to delegate all state operations to the server.
   */
  private proxyToServer<T = unknown>(command: string, args: Record<string, unknown>): Promise<T> {
    return new Promise((resolve, reject) => {
      const cws = this.getClientWs();
      if (!cws) return reject(new Error("No server connection"));
      const proxyId = `proxy-${++this.proxyIdCounter}-${Date.now()}`;
      const timer = setTimeout(() => {
        this.pendingProxyCalls.delete(proxyId);
        reject(new Error("Proxy command timeout"));
      }, 60000);
      this.pendingProxyCalls.set(proxyId, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.wsSend(cws, { type: "proxy_command", proxy_id: proxyId, command, args });
    });
  }

  // ── Agent management ───────────────────────────────────────────────────

  findAgent(idOrName: string): AgentState | undefined {
    if (this.agents.has(idOrName)) return this.agents.get(idOrName)!;
    for (const a of this.agents.values()) if (a.name === idOrName) return a;
    return undefined;
  }

  /** List all agents. Proxies to server when in client mode to get the global agent list. */
  listAgents(): Array<{ id: string; name: string; tools: string[]; lastHeartbeat: number }> | Promise<Array<{ id: string; name: string; tools: string[]; lastHeartbeat: number }>> {
    if (this.isClient()) {
      return this.proxyToServer<Array<{ id: string; name: string; tools: string[]; lastHeartbeat: number }>>("listAgents", {});
    }
    return [...this.agents.values()].map(a => ({
      id: a.id, name: a.name,
      tools: a.tools.map(t => t.name),
      lastHeartbeat: a.lastHeartbeat,
    }));
  }

  // ── Message sending ────────────────────────────────────────────────────

  wsSend(ws: any, data: any): void {
    try {
      // If there's an E2E session for this ws, encrypt the message
      const session = this.getE2eSessionForWs(ws);
      if (session) {
        const payload = session.encrypt(data);
        ws.send(JSON.stringify({ type: "e2e", e2e: payload }));
      } else {
        ws.send(JSON.stringify(data));
      }
    }
    catch (e) { process.stderr.write(`[${this.name}] wsSend error: ${e}\n`); }
  }

  /** Find the E2E session associated with a WebSocket (if any). */
  private getE2eSessionForWs(ws: any): import("./mesh.js").E2eSession | undefined {
    for (const agent of this.agents.values()) {
      if (agent.ws === ws) return this.e2eSessions.get(agent.name);
    }
    return undefined;
  }

  /**
   * Like wsSend but handles async transport sends (e.g., Telegram API calls).
   * Logs errors and emits 'sendFailed' event for observability.
   * Note: returns void immediately — delivery is fire-and-forget.
   * Use the 'sendFailed' event to detect failed deliveries.
   */
  wsSendAsync(ws: any, data: any): void {
    try {
      const result = ws.send(JSON.stringify(data));
      if (result && typeof result.catch === "function") {
        result.catch((e: any) => {
          process.stderr.write(`[${this.name}] wsSendAsync error: ${e}\n`);
          this.emit("sendFailed", { error: String(e), target: data?.chat_id, type: data?.type });
        });
      }
    } catch (e) {
      process.stderr.write(`[${this.name}] wsSendAsync error: ${e}\n`);
      this.emit("sendFailed", { error: String(e), target: data?.chat_id, type: data?.type });
    }
  }

  async callRemoteTool(agentId: string, toolName: string, args: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const agent = this.agents.get(agentId);
      const callId = `call-${++this.callIdCounter}-${Date.now()}`;
      const timer = setTimeout(() => { this.pendingCalls.delete(callId); reject(new Error("Timeout")); }, 60000);
      this.pendingCalls.set(callId, { resolve, reject, timer });

      if (agent) {
        // Direct: we have the agent locally (server-side)
        this.wsSend(agent.ws, { type: "tool_call", call_id: callId, tool_name: toolName, args });
      } else {
        // Proxy: route through the server via client WS connection (client-side)
        const cws = this.getClientWs();
        if (!cws) { clearTimeout(timer); this.pendingCalls.delete(callId); return reject(new Error("Agent not found")); }
        this.wsSend(cws, { type: "tool_call_proxy", target: agentId, call_id: callId, tool_name: toolName, args });
      }
    });
  }

  // ── Routing + Handover (delegated to hub-routing.ts) ──────────────────
  declare sendMessage: (target: string | undefined, content: string, rich?: import("./protocol.js").RichMessageParams) => { ok: boolean; error?: string };
  declare reply: (chatId: string, text: string, rich?: import("./protocol.js").RichMessageParams) => { ok: boolean; error?: string };
  declare wrapEnvelope: (payload: any, opts?: { to?: string; session?: string }) => SessionEnvelope;
  declare route: (envelope: SessionEnvelope, filter?: RecipientFilter) => number;
  declare handover: (chatId: string, toAgentId: string) => { ok: boolean; error?: string } | Promise<{ ok: boolean; error?: string }>;
  declare getChatRoute: (chatId: string) => string | undefined | Promise<string | undefined>;
  declare releaseChat: (chatId: string) => { ok: boolean; error?: string } | Promise<{ ok: boolean; error?: string }>;
  /** @internal */ declare resolvedName: () => string;
  /** @internal */ declare clearRoute: (chatId: string) => void;
  /** @internal */ declare emitMessage: (content: string, chatId: string, user: string) => void;
  /** @internal */ declare resolveTarget: (target: string) => string;
  /** @internal */ declare trySendToRoute: (chatId: string, content: string, from: string, rich?: import("./protocol.js").RichMessageParams) => boolean;
  /** @internal */ declare routeChat: (params: { chatId: string; content: string; from: string; source: "agent" | "channel"; senderAgentId?: string; sourceUrl?: string }) => void;

  // ── Server (delegated to hub-server.ts) ──────────────────────────────
  declare startServer: (port?: number, opts?: { http?: boolean }) => Promise<{ port: number }>;
  /** @internal */ declare startHttpWs: (port: number) => Promise<void>;
  /** @internal */ declare setupAgentConnection: (ws: any, addr: string) => void;
  /** @internal */ declare completeRegistration: (ws: any, addr: string, agentName: string, tools: AgentToolDef[], metadata: any, ref: { id: string | null }) => void;

  // ── Approval / Pairing ──────────────────────────────────────────────────

  private generatePairingCode(): string {
    return Math.random().toString(36).slice(2, 8).toUpperCase();
  }

  /** Approve a pending agent by pairing code. Adds to allowlist and completes registration. */
  async approveAgent(code: string): Promise<{ ok: boolean; name?: string; error?: string }> {
    const pending = this.pendingAgents.get(code);
    if (!pending) return { ok: false, error: `No pending agent with code "${code}"` };
    this.pendingAgents.delete(code);

    // Add agent name to allowlist in settings
    const settings = await this.loadSettings();
    settings.access = settings.access ?? {};
    settings.access.allowlist = settings.access.allowlist ?? [];
    if (!settings.access.allowlist.includes(pending.name)) {
      settings.access.allowlist.push(pending.name);
    }
    await this.saveSettings(settings);

    // Key exchange: send our public key to the approved agent
    const { loadOrCreateIdentity } = await import("./mesh.js");
    const identity = await loadOrCreateIdentity(getTalonHome());
    this.wsSend(pending.ws, { type: "key_exchange", publicKey: identity.publicKey });

    // Store peer's public key if provided during registration
    const peerPublicKey = pending.metadata?.publicKey as string | undefined;
    if (peerPublicKey) {
      this.peerKeys.set(pending.name, peerPublicKey);
      process.stderr.write(`[${this.name}] Key exchange with "${pending.name}" complete\n`);
    }

    // Complete registration with a fresh ref
    const ref = { id: null as string | null };
    this.completeRegistration(pending.ws, pending.address, pending.name, pending.tools, pending.metadata, ref);
    process.stderr.write(`[${this.name}] Agent "${pending.name}" approved (code: ${code})\n`);
    return { ok: true, name: pending.name };
  }

  /** Deny a pending agent by pairing code. Closes the connection. */
  denyAgent(code: string): { ok: boolean; name?: string; error?: string } {
    const pending = this.pendingAgents.get(code);
    if (!pending) return { ok: false, error: `No pending agent with code "${code}"` };
    this.pendingAgents.delete(code);
    this.wsSend(pending.ws, { type: "register_ack", status: "denied", message: "Connection denied by host" });
    try { pending.ws.close(); } catch {}
    process.stderr.write(`[${this.name}] Agent "${pending.name}" denied (code: ${code})\n`);
    return { ok: true, name: pending.name };
  }

  /** List all pending agent approvals */
  listPendingAgents(): Array<{ code: string; name: string; address: string; tools: string[]; requestedAt: number }> {
    return [...this.pendingAgents.values()].map((pa) => ({
      code: pa.code,
      name: pa.name,
      address: pa.address,
      tools: pa.tools.map((t) => t.name),
      requestedAt: pa.requestedAt,
    }));
  }


  // ── Agent Groups ─────────────────────────────────────────────────────
  //
  // Groups are type-agnostic: members can be WS agents, persistent agents,
  // Telegram channels, or any other reachable target. Members use "type:name"
  // format (e.g. "ws:backend", "telegram:938185675", "agent:dexter").
  // Bare names (no colon) are auto-resolved.
  //
  // Each member has a receive mode:
  //   "all"   — receive every group message (default)
  //   "@only" — only receive when @mentioned in the message text
  //
  // Broadcasting always goes to ALL qualifying members (like Slack/Telegram).
  // @mentions are attention markers, not routing filters (unless member mode is "@only").

  /** Parse a qualified member string ("ws:name") into [prefix, name]. */
  private parseGroupMember(member: string): [string, string] {
    const idx = member.indexOf(":");
    if (idx === -1) return ["", member];
    return [member.slice(0, idx), member.slice(idx + 1)];
  }

  /** Resolve a qualified member to a sendMessage target. */
  private resolveGroupTarget(member: string): string {
    const [prefix, name] = this.parseGroupMember(member);
    if (!prefix || prefix === "ws" || prefix === "unix" || prefix === "agent") return name;
    return name;
  }

  /** Extract bare name from a qualified member string. */
  private groupMemberName(member: string): string {
    return this.parseGroupMember(member)[1];
  }

  /** Create a new group. */
  createGroup(name: string): { ok: boolean; error?: string } | Promise<{ ok: boolean; error?: string }> {
    if (this.isClient()) {
      return this.proxyToServer<{ ok: boolean; error?: string }>("createGroup", { name });
    }
    if (this.groups.has(name)) return { ok: false, error: `Group "${name}" already exists` };
    this.groups.set(name, new Map());
    process.stderr.write(`[${this.name}] Group "${name}" created\n`);
    return { ok: true };
  }

  /**
   * Add a member to a group. Creates the group if it doesn't exist.
   *
   * Accepts "type:name" format (e.g. "ws:backend", "telegram:12345", "agent:dexter")
   * or bare names which are auto-resolved by checking connected agents.
   *
   * @param receiveMode  "all" (default) or "@only" (only when @mentioned)
   */
  addToGroup(groupName: string, member: string, receiveMode: "all" | "@only" = "all"): { ok: boolean; error?: string } | Promise<{ ok: boolean; error?: string }> {
    if (this.isClient()) {
      return this.proxyToServer<{ ok: boolean; error?: string }>("addToGroup", { groupName, agentId: member, receiveMode });
    }
    // Auto-prefix bare names
    let qualified = member;
    if (!member.includes(":")) {
      const agent = this.findAgent(member);
      if (agent) {
        qualified = `ws:${agent.name}`;
        agent.groupName = groupName;
      }
    } else {
      const [prefix, name] = this.parseGroupMember(qualified);
      if (prefix === "ws" || prefix === "unix") {
        const agent = this.findAgent(name);
        if (agent) agent.groupName = groupName;
      }
    }
    if (!this.groups.has(groupName)) this.groups.set(groupName, new Map());
    this.groups.get(groupName)!.set(qualified, { name: qualified, mode: receiveMode });
    process.stderr.write(`[${this.name}] Member "${qualified}" (mode:${receiveMode}) added to group "${groupName}"\n`);
    this.broadcastGroupSync("add", groupName, qualified, receiveMode);
    this.notifyGroupJoin(groupName, qualified);
    return { ok: true };
  }

  /** Broadcast a group membership change to all hub peers (role="server" clients). */
  private broadcastGroupSync(op: "add" | "remove", groupName: string, member: string, receiveMode: "all" | "@only"): void {
    const [pfx, mname] = this.parseGroupMember(member);
    const agent = (pfx === "ws" || pfx === "unix" || pfx === "") ? this.findAgent(mname) : undefined;
    const hubPeers = [...this.clients.values()].filter(c => c.role === "server");
    for (const peer of hubPeers) {
      this.wsSend(peer.ws, {
        type: "group_sync", op, groupName, member, receiveMode,
        memberId: agent?.id,
        memberName: agent?.name ?? mname,
      });
    }
  }

  /** Notify existing WS members about a new joiner, and notify the new joiner about existing members. */
  notifyGroupJoin(groupName: string, qualifiedNewMember: string): void {
    const group = this.groups.get(groupName);
    if (!group) return;

    // Collect existing local WS members (excluding the new joiner)
    // Falls back to stored agentId/agentName for remote members synced via group_sync
    const existingWsMembers: Array<{ id: string; name: string }> = [];
    for (const [key, memberData] of group) {
      if (key === qualifiedNewMember) continue;
      const [pfx, mname] = this.parseGroupMember(key);
      if (pfx === "ws" || pfx === "unix" || pfx === "") {
        const a = this.findAgent(mname);
        if (a) {
          existingWsMembers.push({ id: a.id, name: a.name });
        } else if (memberData.agentId && memberData.agentName) {
          existingWsMembers.push({ id: memberData.agentId, name: memberData.agentName });
        }
      }
    }
    if (existingWsMembers.length === 0) return;

    // Resolve new member as a local WS agent (if applicable)
    const [newPfx, newMname] = this.parseGroupMember(qualifiedNewMember);
    const newAgent = (newPfx === "ws" || newPfx === "unix" || newPfx === "")
      ? this.findAgent(newMname)
      : undefined;

    // Notify each existing member about the new joiner
    if (newAgent) {
      const joinMsg = { type: "group_member_joined", group: groupName, memberId: newAgent.id, memberName: newAgent.name };
      for (const { name } of existingWsMembers) {
        const a = this.findAgent(name);
        if (a) this.wsSend(a.ws, joinMsg);
      }
      // Notify the new joiner about all existing members
      this.wsSend(newAgent.ws, { type: "group_members_list", group: groupName, members: existingWsMembers });
    }
  }

  /** Remove a member from a group. Accepts qualified or bare name. */
  removeFromGroup(groupName: string, member: string): { ok: boolean; error?: string } | Promise<{ ok: boolean; error?: string }> {
    if (this.isClient()) {
      return this.proxyToServer<{ ok: boolean; error?: string }>("removeFromGroup", { groupName, agentId: member });
    }
    const group = this.groups.get(groupName);
    if (!group) return { ok: false, error: `Group "${groupName}" not found` };
    // Try exact, then ws:name, then search by bare name
    let found: string | undefined;
    if (group.has(member)) found = member;
    else if (group.has(`ws:${member}`)) found = `ws:${member}`;
    else {
      for (const key of group.keys()) {
        if (this.groupMemberName(key) === member) { found = key; break; }
      }
    }
    if (!found) return { ok: false, error: `"${member}" not in group "${groupName}"` };
    group.delete(found);
    const [prefix, name] = this.parseGroupMember(found);
    if (prefix === "ws" || prefix === "unix" || !prefix) {
      const agent = this.findAgent(name);
      if (agent && agent.groupName === groupName) agent.groupName = undefined;
    }
    process.stderr.write(`[${this.name}] Member "${found}" removed from group "${groupName}"\n`);
    this.broadcastGroupSync("remove", groupName, found, "all");
    return { ok: true };
  }

  /** Delete a group entirely. */
  deleteGroup(name: string): { ok: boolean; error?: string } | Promise<{ ok: boolean; error?: string }> {
    if (this.isClient()) {
      return this.proxyToServer<{ ok: boolean; error?: string }>("deleteGroup", { name });
    }
    const group = this.groups.get(name);
    if (!group) return { ok: false, error: `Group "${name}" not found` };
    for (const [key] of group) {
      const [prefix, mName] = this.parseGroupMember(key);
      if (prefix === "ws" || prefix === "unix" || !prefix) {
        const agent = this.findAgent(mName);
        if (agent && agent.groupName === name) agent.groupName = undefined;
      }
    }
    this.groups.delete(name);
    process.stderr.write(`[${this.name}] Group "${name}" deleted\n`);
    return { ok: true };
  }

  /** List all groups with their members. */
  listGroups(): Array<{ name: string; members: GroupMember[] }> | Promise<Array<{ name: string; members: GroupMember[] }>> {
    if (this.isClient()) {
      return this.proxyToServer<Array<{ name: string; members: GroupMember[] }>>("listGroups", {});
    }
    const result: Array<{ name: string; members: GroupMember[] }> = [];
    for (const [name, memberMap] of this.groups) {
      result.push({ name, members: [...memberMap.values()] });
    }
    return result;
  }

  /**
   * Broadcast a message to all group members (except sender).
   * Members with mode "@only" only receive if @mentioned in the message.
   * All members with mode "all" always receive.
   */
  broadcastToGroup(groupName: string, content: string, from: string): { ok: boolean; sent: number; error?: string } | Promise<{ ok: boolean; sent: number; error?: string }> {
    if (this.isClient()) {
      return this.proxyToServer<{ ok: boolean; sent: number; error?: string }>("broadcastToGroup", { groupName, content, from });
    }
    const group = this.groups.get(groupName);
    if (!group) return { ok: false, sent: 0, error: `Group "${groupName}" not found` };

    // Extract @mentions from content for "@only" mode filtering
    const mentions = content.match(/@([\w-]+)/g)?.map(m => m.slice(1)) ?? [];
    const mentionedNames = new Set(mentions);

    let sent = 0;
    for (const [key, member] of group) {
      const bareName = this.groupMemberName(key);
      // Skip sender
      if (bareName === from) continue;
      // Skip "@only" members unless @mentioned
      if (member.mode === "@only" && !mentionedNames.has(bareName)) continue;

      const [prefix, name] = this.parseGroupMember(key);
      // WS/Unix agents: send group_broadcast directly for proper message typing
      if (prefix === "ws" || prefix === "unix" || !prefix) {
        const agent = this.findAgent(name);
        if (agent) {
          this.wsSend(agent.ws, { type: "group_broadcast", from, content, meta: { group: groupName } });
          sent++;
          continue;
        }
      }
      // All other types (persistent agents, channels): route via sendMessage
      const target = this.resolveGroupTarget(key);
      const result = this.sendMessage(target, content);
      if (result.ok) sent++;
    }
    process.stderr.write(`[${this.name}] Group broadcast to "${groupName}": ${sent} delivered\n`);
    return { ok: true, sent };
  }

  /** Remove a WS agent from all groups on disconnect. */
  private removeFromAllGroups(agentId: string): void {
    const agent = this.agents.get(agentId);
    const agentName = agent?.name;
    for (const [groupName, members] of this.groups) {
      const candidates = [agentId, agentName, `ws:${agentName}`, `unix:${agentName}`].filter(Boolean) as string[];
      for (const c of candidates) {
        if (members.has(c)) {
          members.delete(c);
          process.stderr.write(`[${this.name}] "${c}" removed from group "${groupName}" (disconnect)\n`);
        }
      }
    }
  }

  // ── Client connection (delegated to hub-client.ts) ───────────────────
  declare connect: (url: string, agentName?: string, connectionConfig?: Record<string, unknown>) => Promise<void>;

  // ── Auto-setup ─────────────────────────────────────────────────────────

  /**
   * Check if the daemon is running by verifying both the PID file and that the
   * server port is actually listening.  This avoids races where the PID file
   * exists but the daemon hasn't started its server yet, or the PID file is
   * stale but the port happens to be in use by something else.
   */
  private async isDaemonListening(): Promise<boolean> {
    // 1) Check PID file — fast, cheap
    const daemonPidFile = join(homedir(), ".talon", "daemon.pid");
    let pidAlive = false;
    try {
      const pid = parseInt((await readFile(daemonPidFile, "utf-8")).trim(), 10);
      if (Number.isFinite(pid)) { process.kill(pid, 0); pidAlive = true; }
    } catch {}
    if (!pidAlive) return false;

    // 2) Check if daemon's Unix socket is accepting connections (preferred)
    //    Falls back to TCP port check if Unix socket not found.
    const port = this.opts.port ?? this.defaultPort;
    const socketPath = `/tmp/talon-${port}.sock`;
    try {
      const { createConnection } = await import("node:net");
      const { existsSync } = await import("node:fs");

      // Try Unix socket first (fast, no TCP overhead)
      if (existsSync(socketPath)) {
        const unixOk = await new Promise<boolean>((resolve) => {
          const sock = createConnection({ path: socketPath }, () => { sock.destroy(); resolve(true); });
          sock.on("error", () => resolve(false));
          sock.setTimeout(1000, () => { sock.destroy(); resolve(false); });
        });
        if (unixOk) return true;
      }

      // Fallback: check TCP port (daemon may have HTTP+WS enabled)
      const tcpOk = await new Promise<boolean>((resolve) => {
        const sock = createConnection({ host: "127.0.0.1", port }, () => { sock.destroy(); resolve(true); });
        sock.on("error", () => resolve(false));
        sock.setTimeout(1000, () => { sock.destroy(); resolve(false); });
      });
      return tcpOk;
    } catch {
      return false;
    }
  }

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
  async tryKillOrphanOnPort(port: number): Promise<boolean> {
    const daemonPidFile = join(homedir(), ".talon", "daemon.pid");
    let orphanPid: number;
    try {
      orphanPid = parseInt((await readFile(daemonPidFile, "utf-8")).trim(), 10);
      if (!Number.isFinite(orphanPid)) return false;
      // Check the process is alive
      process.kill(orphanPid, 0);
    } catch {
      // No PID file or process not alive — not an orphan we can handle
      return false;
    }

    // Check if the orphan's parent is init/launchd (PID 1) — meaning its
    // original parent (the MCP plugin) has exited, leaving it orphaned.
    try {
      const { execSync } = await import("node:child_process");
      const ppidStr = execSync(`ps -o ppid= -p ${orphanPid}`, { encoding: "utf-8" }).trim();
      const ppid = parseInt(ppidStr, 10);

      // If the orphan's parent is still alive and is in our process tree,
      // it's a legitimate server — don't kill it.
      if (Number.isFinite(ppid) && ppid !== 1) {
        // Check if we share an ancestor — walk up from our PID
        let current = process.pid;
        while (current > 1) {
          if (current === orphanPid) return false; // the "orphan" is actually our ancestor
          try {
            const pStr = execSync(`ps -o ppid= -p ${current}`, { encoding: "utf-8" }).trim();
            current = parseInt(pStr, 10);
            if (!Number.isFinite(current)) break;
          } catch { break; }
        }
        // The orphan's parent is alive but not in our tree — might still be
        // a valid server from another session. Only kill if PPID is 1.
        if (ppid !== 1) return false;
      }
    } catch {
      // Can't determine PPID (e.g. on non-Unix) — don't risk killing
      return false;
    }

    // The process is orphaned (PPID = 1). Kill it.
    process.stderr.write(`[${this.name}] Killing orphan server process ${orphanPid} on port ${port}\n`);
    try {
      process.kill(orphanPid, "SIGTERM");
      // Wait briefly for graceful shutdown
      await new Promise<void>((resolve) => setTimeout(resolve, 500));
      try {
        process.kill(orphanPid, 0); // check if still alive
        // Still alive — force kill
        process.kill(orphanPid, "SIGKILL");
        await new Promise<void>((resolve) => setTimeout(resolve, 300));
      } catch {
        // Already dead after SIGTERM — good
      }
      // Clean up stale socket file
      const socketPath = `/tmp/talon-${port}.sock`;
      try {
        const { unlinkSync, existsSync } = await import("node:fs");
        if (existsSync(socketPath)) unlinkSync(socketPath);
      } catch {}
      return true;
    } catch {
      return false;
    }
  }

  async autoSetup(): Promise<void> {
    // Init machine ID (saved to ~/.talon/machine-id)
    await getMachineId();

    // Check if daemon is running AND its server is listening — if so, connect as WS client only.
    // Skip server start AND channel connections (the daemon owns those).
    const daemonUp = await this.isDaemonListening();

    if (daemonUp) {
      process.stderr.write(`[${this.name}] Daemon running — connecting as client only (no server, no channels)\n`);
      const autoUrl = `auto://localhost:${this.opts.port ?? this.defaultPort}`;
      try { await this.connect(autoUrl); } catch {}
      this.startHealthMonitor();
      await this.fireHooks("postSetup", { serverRunning: false, clientConnected: this.clientConnected(), daemon: true });
      return;
    }

    // ── Full setup (this instance IS the authority — daemon or standalone) ──

    // Restore persisted state (chatRoutes, groups) — runs after agents reconnect
    setTimeout(() => this.restoreState().catch(() => {}), 5000);

    // Load persisted shell hooks from settings.json
    await this.loadShellHooks();

    // Restore persisted contacts
    await this.restoreContacts();

    // Load existing per-agent configs
    await this.loadAgentConfigs();

    // Read port from settings if not set in opts
    const settings = await this.loadSettings();

    // First-time init: write default transports (unix only — no HTTP+WS until explicitly enabled)
    if (!settings.transports && Object.keys(settings).length === 0) {
      settings.transports = { unix: [{ enabled: true }], ws: [], telegram: [] };
      await this.saveSettings({ transports: settings.transports });
    }

    const port = this.opts.port ?? (settings as any).port ?? this.defaultPort;

    // Auto-start server
    let isClient = false;
    if (this.opts.autoStart !== false) {
      try { await this.startServer(port); }
      catch (e: any) {
        if (e?.code === "EADDRINUSE") {
          // Check if the process on the port is a stale orphan we can kill
          const killed = await this.tryKillOrphanOnPort(port);
          if (killed) {
            // Orphan killed — retry startServer once
            try {
              await this.startServer(port);
            } catch (retryErr: any) {
              // Retry also failed — fall back to client mode
              process.stderr.write(`[${this.name}] Port ${port} still in use after orphan kill, connecting as client only (no channels)\n`);
              isClient = true;
              const autoUrl = `auto://localhost:${port}`;
              try { await this.connect(autoUrl, this.name); } catch {}
              this.startHealthMonitor();
              await this.fireHooks("postSetup", { serverRunning: false, clientConnected: this.clientConnected(), daemon: false });
              return;
            }
          } else {
            // Not an orphan — legitimate server running, fall back to client mode
            process.stderr.write(`[${this.name}] Port ${port} in use, connecting as client only (no channels)\n`);
            isClient = true;
            // Connect to existing hub — auto:// tries Unix socket first, falls back to WS
            const autoUrl = `auto://localhost:${port}`;
            try { await this.connect(autoUrl, this.name); } catch {}
            this.startHealthMonitor();
            await this.fireHooks("postSetup", { serverRunning: false, clientConnected: this.clientConnected(), daemon: false });
            return;
          }
        }
      }
    }

    // Auto-reconnect saved connections (Telegram, etc.) — only if we are the server
    if (this.opts.autoConnect !== false) {
      try {
        const registeredServers = await this.getRegisteredServers();
        for (const s of registeredServers ?? []) {
          try { process.kill(s.pid!, 0); } catch { await this.unregisterServer(s.port!); }
        }
        if (!this.serverRunning()) {
          const autoUrl = `auto://localhost:${port}`;
          if (!this.clients.has(autoUrl)) {
            try { await this.connect(autoUrl); } catch {}
          }
        }
        // Restore saved channel connections (Telegram, etc.)
        // Skip hub-to-hub connections (unix/ws to localhost) to prevent reconnect loops
        const connections = await this.getConnections();
        if (connections?.length) {
          for (const conn of connections) {
            const isHubLink = conn.url.startsWith("unix://") || conn.url.startsWith("ws://localhost") || conn.url.startsWith("auto://localhost");
            if (isHubLink && !conn.url.startsWith("telegram://")) continue; // skip hub-to-hub
            if (!this.clients.has(conn.url)) {
              try { await this.connect(conn.url, conn.name, (conn as any).config); } catch {}
            }
          }
        }

        // Auto-connect all enabled transports from settings
        await this.autoConnectTransports(settings, connections);
      } catch {}
    }

    // Auto-relaunch persistent agents that were running before shutdown
    if (this.serverRunning()) {
      this.relaunchPersistentAgents().catch((e) => {
        process.stderr.write(`[${this.name}] Persistent agent relaunch failed: ${e}\n`);
      });
    }

    // Start continuous health monitor
    this.startHealthMonitor();

    // Fire postSetup hooks after server started and connections established
    await this.fireHooks("postSetup", { serverRunning: this.serverRunning(), clientConnected: this.clientConnected() });

    // Non-blocking auto-update check
    if (this.opts.autoUpdate) {
      this.autoUpdate().catch((e) => {
        process.stderr.write(`[${this.name}] Auto-update check failed: ${e}\n`);
      });
    }

    // Auto-reload: watch dist/ for changes (from git pull + build) and hot-reload
    // Only in dev mode — production should not self-mutate
    if (this.opts.devMode || process.env.TALON_DEV === "1") {
      this.startFileWatcher();
    }
  }

  /** Start all enabled transports from settings.transports (many-to-many support). */
  private async autoConnectTransports(settings: HubSettings, existingConnections: HubSettings["connections"]): Promise<void> {
    const transports = settings.transports ?? {};
    // Normalize a transport entry to an array (supports both single-object and array forms)
    const toArray = (val: unknown): Array<Record<string, unknown>> => {
      if (!val) return [];
      if (Array.isArray(val)) return val as Array<Record<string, unknown>>;
      return [val as Record<string, unknown>];
    };

    // ── Telegram (supports multiple bots) ──────────────────────────────
    const telegramEntries = toArray(transports.telegram).filter(e => e.enabled !== false);
    for (const entry of telegramEntries) {
      const connName = (entry.name as string) ?? "telegram";
      const token = (entry.botToken as string) ?? process.env.TELEGRAM_BOT_TOKEN;
      // Use stable URL keyed by token suffix so multiple bots don't collide,
      // but don't embed the display name — that changes without creating a new bot.
      const tokenKey = token ? token.split(":")[0] : "bot";
      const connUrl = `telegram://${tokenKey}`;
      const alreadyConnected = existingConnections?.some(c => c.url === connUrl)
        || [...this.clients.keys()].some(k => k === connUrl);
      if (!alreadyConnected) {
        if (token) {
          try { await this.connect(connUrl, connName, { ...entry, botToken: token }); } catch {}
        }
      }
    }
    // Env-var fallback: no transports.telegram config defined at all
    if (telegramEntries.length === 0) {
      const hasTgConn = existingConnections?.some(c => c.url.startsWith("telegram://"))
        || [...this.clients.keys()].some(k => k.startsWith("telegram://"));
      if (!hasTgConn && process.env.TELEGRAM_BOT_TOKEN) {
        try { await this.connect("telegram://bot", "telegram"); } catch {}
      }
    }

    // ── Additional WS ports beyond the default ──────────────────────────
    // The default port is already started by startServer(); additional ports come from settings
    const wsEntries = toArray(transports.ws).filter(e => e.enabled === true);
    for (const entry of wsEntries) {
      const p = (entry.port as number) ?? this.defaultPort;
      if (!this.servers.has(`ws:${p}`)) {
        try { await (this as any).startHttpWs(p); } catch {}
      }
    }
  }

  /** Watch the SDK's dist/ directory for changes and auto-reload. */
  private startFileWatcher(): void {
    if (this.fileWatcher) return;
    try {
      const { watch } = require("node:fs");
      const { dirname } = require("node:path");
      const dir = __dirname ?? dirname(new URL(import.meta.url).pathname);
      let debounce: ReturnType<typeof setTimeout> | null = null;
      this.fileWatcher = watch(dir, { recursive: true }, (_event: string, filename: string) => {
        if (!filename?.endsWith(".js")) return;
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => {
          process.stderr.write(`[${this.name}] File change detected (${filename}), restarting for hot-reload...\n`);
          this.emit("autoReload", { filename });
          process.exit(0);
        }, 2000);
      });
      process.stderr.write(`[${this.name}] File watcher active on ${dir}\n`);

      // Auto-sync: check git remote for new commits every 60s, pull + build if found
      this.startAutoSync(dir);
    } catch {}
  }

  /** Periodically check git remote and pull + build if new commits available. */
  private startAutoSync(sdkDir: string): void {
    const { execSync } = require("node:child_process");
    const { dirname } = require("node:path");
    // Walk up to find the git root (sdkDir might be dist/)
    let gitDir = sdkDir;
    for (let i = 0; i < 5; i++) {
      try { execSync("git rev-parse --is-inside-work-tree", { cwd: gitDir, stdio: "ignore" }); break; }
      catch { gitDir = dirname(gitDir); }
    }

    setInterval(() => {
      try {
        // Fetch and check if behind
        execSync("git fetch origin --quiet 2>/dev/null", { cwd: gitDir, timeout: 10000 });
        const behind = execSync("git rev-list HEAD..origin/main --count", { cwd: gitDir, encoding: "utf-8", timeout: 5000 }).trim();
        if (behind !== "0") {
          process.stderr.write(`[${this.name}] Auto-sync: ${behind} new commit(s), pulling...\n`);
          execSync("git pull origin main --ff-only 2>/dev/null", { cwd: gitDir, timeout: 30000 });
          execSync("npm run build 2>/dev/null", { cwd: gitDir, timeout: 60000 });
          process.stderr.write(`[${this.name}] Auto-sync: pulled and rebuilt, restarting...\n`);
          // File watcher will detect the .js changes and restart
        }
      } catch {}
    }, 60000);
    process.stderr.write(`[${this.name}] Auto-sync active (checking git every 60s)\n`);
  }

  // ── Reload ─────────────────────────────────────────────────────────────

  async reload(): Promise<{ checks: string[]; issues: string[]; summary: Record<string, number> }> {
    const issues: string[] = [];
    const checks: string[] = [];

    // Backup current settings before reload (for rollback on failure)
    try {
      const { copyFile } = await import("node:fs/promises");
      const settingsPath = join(homedir(), ".talon", "settings.json");
      await copyFile(settingsPath, settingsPath + ".bak");
      checks.push("✓ settings.json backed up to .bak");
    } catch {}

    const settings = await this.loadSettingsSafe();
    checks.push("✓ settings.json loaded");

    // Hot-reload transport modules by cache-busting the ESM import
    const cacheBust = `?t=${Date.now()}`;
    await import(`./transports/index.js${cacheBust}`).catch(() => import("./transports/index.js"));
    const proto = await import(`./protocol.js${cacheBust}`).catch(() => import("./protocol.js"));
    const registered = proto.listChannels();
    checks.push(`✓ ${registered.length} channels: ${registered.join(", ")}`);

    if (settings.transports) {
      for (const [type, config] of Object.entries(settings.transports)) {
        if (!registered.includes(type)) {
          issues.push(`✗ ${type}: not registered`);
        } else if (type === "telegram") {
          const token = (config as any).botToken ?? process.env.TELEGRAM_BOT_TOKEN;
          if (!token) { issues.push(`✗ telegram: missing botToken`); }
          else {
            try {
              const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
              const data = await res.json() as any;
              if (data.ok) checks.push(`✓ telegram: @${data.result.username}`);
              else issues.push(`✗ telegram: invalid token`);
            } catch { issues.push(`✗ telegram: API unreachable`); }
          }
        } else {
          checks.push(`✓ ${type}: configured`);
        }
      }
    }

    // Check servers
    for (const [id, s] of this.servers) {
      if (s.port) {
        try {
          const res = await fetch(`http://localhost:${s.port}/health`);
          if (res.ok) checks.push(`✓ server ${id}: healthy`);
          else issues.push(`✗ server ${id}: unhealthy`);
        } catch { issues.push(`✗ server ${id}: not responding`); }
      }
    }

    // Hot-reconnect: disconnect all channel clients and reconnect with fresh transport code
    const connections = await this.getConnections();
    let reconnected = 0;
    // Clear channelForChat — old entries point to stale transport objects
    this.channelForChat.clear();
    // Disconnect existing channel clients first (so they pick up new transport code)
    for (const [url, client] of this.clients) {
      if (client.role === "channel") {
        if (client.heartbeatTimer) {
          clearInterval(client.heartbeatTimer);
          client.heartbeatTimer = undefined;
        }
        try { client.ws.close(); } catch {}
        this.clients.delete(url);
        checks.push(`✓ disconnected ${url} for hot-reload`);
      }
    }
    // Reconnect all saved connections
    for (const conn of connections ?? []) {
      if (!this.clients.has(conn.url)) {
        try { await this.connect(conn.url, conn.name, (conn as any).config); reconnected++; checks.push(`✓ reconnected ${conn.url}`); }
        catch { issues.push(`✗ reconnect ${conn.url} failed`); }
      }
    }

    // Prune stale
    const now = Date.now();
    let pruned = 0;
    for (const [id, a] of this.agents) {
      if (now - a.lastHeartbeat > 90000) { a.ws.close(); this.agents.delete(id); pruned++; }
    }
    if (pruned) checks.push(`✓ pruned ${pruned} stale agents`);

    // Re-load shell hooks (may have been updated in settings)
    await this.loadShellHooks();

    // Rollback: if reload caused critical failures (no channels connected), restore .bak
    if (this.clients.size === 0 && reconnected === 0 && (connections?.length ?? 0) > 0) {
      try {
        const { copyFile } = await import("node:fs/promises");
        const settingsPath = join(homedir(), ".talon", "settings.json");
        await copyFile(settingsPath + ".bak", settingsPath);
        issues.push("✗ ROLLBACK: no channels connected after reload — restored settings.json from .bak");
        // Re-load from backup and try reconnecting
        const bakSettings = await this.loadSettingsSafe();
        const bakConns = bakSettings.connections ?? [];
        for (const conn of bakConns) {
          if (!this.clients.has(conn.url)) {
            try { await this.connect(conn.url!, conn.name, (conn as any).config); reconnected++; } catch {}
          }
        }
      } catch {}
    }

    const result = { checks, issues, summary: { servers: this.servers.size, clients: this.clients.size, agents: this.agents.size, reconnected } };
    await this.fireHooks("onReload", result);
    return result;
  }

  // ── Settings helpers (delegated to hub-settings.ts) ─────────────────────
  // These methods are installed via installSettings() at the bottom of the file.
  // Use `declare` so TypeScript does NOT emit instance property assignments that override the prototype.
  declare loadSettings: () => Promise<HubSettings>;
  declare loadSettingsSafe: () => Promise<HubSettings>;
  declare saveSettings: (settings: HubSettings) => Promise<void>;
  declare registerServer: (url: string, name: string, port: number) => Promise<void>;
  declare unregisterServer: (port: number) => Promise<void>;
  declare getRegisteredServers: () => Promise<HubSettings["servers"]>;
  declare addConnection: (url: string, name: string, config?: Record<string, unknown>) => Promise<void>;
  declare removeConnection: (url: string) => Promise<void>;
  declare getConnections: () => Promise<HubSettings["connections"]>;
  declare persistState: () => Promise<void>;
  declare restoreState: () => Promise<void>;

  // ── Contact Registry (delegated to hub-contacts.ts) ──────────────────
  declare registerContact: (name: string, channelType: string, id: string, url?: string) => { ok: boolean };
  declare removeContact: (name: string) => { ok: boolean; error?: string };
  declare resolveContact: (nameOrId: string) => { contact: ContactEntry; channel: ContactChannel } | undefined;
  declare listContacts: () => ContactEntry[];
  /** @internal */ declare autoRegisterContact: (userName: string, chatId: string, channelType: string, url?: string) => void;
  /** @internal */ declare persistContacts: () => Promise<void>;
  /** @internal */ declare restoreContacts: () => Promise<void>;

  // ── Per-Agent Config ───────────────────────────────────────────────────

  /** Load all per-agent configs from disk and log them. */
  private async loadAgentConfigs(): Promise<void> {
    try {
      const configs = await listAgentConfigs(this.agentConfigDir);
      if (configs.length > 0) {
        process.stderr.write(`[${this.name}] Loaded ${configs.length} per-agent config(s) from ${this.agentConfigDir}\n`);
        for (const c of configs) {
          process.stderr.write(`[${this.name}]   agent: ${c.name} (${c.id})\n`);
        }
      }
    } catch {
      /* agents dir may not exist yet — that's fine */
    }
  }

  /** Persist per-agent config for a specific agent to its own file. */
  async persistAgentConfig(agentId: string): Promise<void> {
    const agent = this.agents.get(agentId);
    if (!agent) return;

    // Build per-agent state from hub maps
    const chatRoutes: Record<string, { agentName: string; channel?: string; channelUrl?: string }> = {};
    for (const [chatId, routedAgentId] of this.chatRoutes.entries()) {
      if (routedAgentId === agentId) {
        const channel = this.channelForChat.get(chatId);
        chatRoutes[chatId] = {
          agentName: agent.name,
          channel: channel?.transport,
          channelUrl: channel?.url,
        };
      }
    }

    const groups: Record<string, string[]> = {};
    for (const [groupName, memberMap] of this.groups.entries()) {
      // Check if this agent is a member (by ID, name, or qualified name)
      const isMember = memberMap.has(agentId) || memberMap.has(agent.name) || memberMap.has(`ws:${agent.name}`) || memberMap.has(`unix:${agent.name}`);
      if (isMember) {
        groups[groupName] = [...memberMap.keys()];
      }
    }

    // Load existing config or create new one
    const existing = await loadAgentConfig(agent.id, this.agentConfigDir) ?? {
      id: agent.id,
      name: agent.name,
    };

    existing.name = agent.name;
    existing.state = { chatRoutes, groups };
    // Persist agent-level permissions
    if (agent.allowedChannels?.length) existing.allowedChannels = agent.allowedChannels;
    if (agent.allowedAgents?.length) existing.allowedAgents = agent.allowedAgents;
    if (agent.intents?.length) existing.intents = agent.intents;

    // Persist contacts that belong to this agent (all contacts for now)
    const contactsObj: Record<string, { name: string; channels: Array<{ type: string; id: string; url: string }> }> = {};
    for (const [name, entry] of this.contacts) {
      contactsObj[name] = { name: entry.name, channels: entry.channels };
    }
    existing.contacts = contactsObj;

    await saveAgentConfig(existing, this.agentConfigDir);
  }

  // ── Persistent Agent Relaunch ──────────────────────────────────────────

  /**
   * Scan ~/.talon/agents/{name}/agent.json for agents with status:"running"
   * and relaunch them with their saved config. Auto-restarts agents that
   * were active before the hub shut down.
   */
  private async relaunchPersistentAgents(): Promise<void> {
    const { readdir, readFile: rf, stat: st } = await import("node:fs/promises");
    const agentsDir = join(homedir(), ".talon", "agents");
    let entries: string[];
    try { entries = await readdir(agentsDir); } catch { return; }

    const { launchAgent } = await import("./tools/agent-launcher.js");
    let relaunched = 0;

    for (const name of entries) {
      const dir = join(agentsDir, name);
      try {
        const s = await st(dir);
        if (!s.isDirectory()) continue;
      } catch { continue; }

      const metaPath = join(dir, "agent.json");
      let meta: any;
      try {
        meta = JSON.parse(await rf(metaPath, "utf-8"));
      } catch { continue; }

      // Only relaunch agents that were running when the hub last stopped
      if (meta.status !== "running") continue;

      process.stderr.write(`[${this.name}] Relaunching persistent agent "${name}" (mode: ${meta.mode ?? "master"})\n`);
      try {
        await launchAgent(name, {
          mode: meta.mode,
          prompt: meta.prompt,
          botToken: meta.botToken,
          hubUrl: meta.hubUrl ?? `ws://localhost:${this.defaultPort}`,
          cwd: meta.cwd ?? meta.folder,
          additionalDirectories: meta.additionalDirectories,
          model: meta.model,
          allowedTools: meta.allowedTools,
          disallowedTools: meta.disallowedTools,
          onOutput: (agentName: string, text: string, chatId?: string) => {
            if (chatId) {
              this.reply(chatId, text);
            }
          },
        });
        relaunched++;
      } catch (e) {
        process.stderr.write(`[${this.name}] Failed to relaunch "${name}": ${e}\n`);
      }
    }

    if (relaunched > 0) {
      process.stderr.write(`[${this.name}] Relaunched ${relaunched} persistent agent(s)\n`);
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  private genId(): string { return crypto.randomUUID(); }

  /** Infer channel type from a chat_id or connected client info. */
  private inferChannelType(chatId: string): string {
    // Check if any connected client matches this chatId
    for (const client of this.clients.values()) {
      if (client.channelId.includes(chatId)) return client.transport;
    }
    // Fallback heuristic: purely numeric ids are likely telegram
    if (/^\d+$/.test(chatId)) return "telegram";
    return "unknown";
  }

  /** Get members of a group in protocol format. */
  private getGroupMembers(groupName: string): GroupMember[] {
    const group = this.groups.get(groupName);
    if (!group) return [];
    return [...group.values()];
  }

  detectTransport(url: string): string {
    if (url.startsWith("ws://") || url.startsWith("wss://")) return "websocket";
    if (url.startsWith("unix://") || url.startsWith("/")) return "unix";
    if (url.startsWith("telegram://")) return "telegram";
    if (url.startsWith("auto://")) return "auto";
    return "websocket";
  }

  /** Check if a URL targets localhost or 127.0.0.1 */
  private isLocalUrl(url: string): boolean {
    try {
      // Handle auto:// by swapping to ws:// for URL parsing
      const parseable = url.startsWith("auto://") ? url.replace("auto://", "ws://") : url;
      const u = new URL(parseable);
      return u.hostname === "localhost" || u.hostname === "127.0.0.1";
    } catch {
      return false;
    }
  }

  /** Extract port number from a URL (supports ws://, auto://) */
  private extractPort(url: string): number | null {
    try {
      const parseable = url.startsWith("auto://") ? url.replace("auto://", "ws://") : url;
      const u = new URL(parseable);
      return u.port ? parseInt(u.port, 10) : null;
    } catch {
      return null;
    }
  }

  /** Convert auto:// URL to ws:// URL */
  private autoToWsUrl(url: string): string {
    return url.replace(/^auto:\/\//, "ws://");
  }

  // ── Health Monitor (delegated to hub-health.ts) ──────────────────────
  declare getHealth: () => Promise<HealthSnapshot>;
  declare startHealthMonitor: (intervalMs?: number) => void;
  declare stopHealthMonitor: () => void;

  /** Get status summary — proxies to main hub when in client mode */
  getStatus(): Record<string, any> | Promise<Record<string, any>> {
    if (this.isClient()) {
      return this.proxyToServer<Record<string, any>>("getStatus", {});
    }
    return {
      servers: [...this.servers.entries()].map(([k, s]) => ({ id: k, type: s.type, port: s.port })),
      clients: [...this.clients.entries()].map(([k, c]) => ({ id: c.id, url: k, channelId: c.channelId, channel: c.transport, name: c.name })),
      agents: this.agents.size,
      chatRoutes: this.chatRoutes.size,
    };
  }
}

// ── Install extracted modules onto ChannelHub prototype ──────────────────
installSettings(ChannelHub);
installHooks(ChannelHub);
installUpdate(ChannelHub);
installHealth(ChannelHub);
installContacts(ChannelHub);
installRouting(ChannelHub);
installClient(ChannelHub);
installServer(ChannelHub);
installCommands(ChannelHub);
