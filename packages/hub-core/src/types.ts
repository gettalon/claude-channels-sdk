/**
 * Hub domain types — extracted from root src/hub.ts.
 *
 * These types define hub-level state structures, configuration,
 * and supporting data shapes. Message types live in @gettalon/protocol.
 */
import type { AgentToolDef } from "@gettalon/protocol";

// ── Agent State ─────────────────────────────────────────────────────────────

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

// ── Groups & Targets ────────────────────────────────────────────────────────

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

// ── Contacts ────────────────────────────────────────────────────────────────

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

// ── Client & Server ─────────────────────────────────────────────────────────

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

// ── Hooks ────────────────────────────────────────────────────────────────────

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

// ── Settings & Options ──────────────────────────────────────────────────────

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
  network?: {
    /** Bind address for HTTP+WS server. Defaults to "127.0.0.1" (loopback only). Use "0.0.0.0" to expose on all interfaces. */
    bindHost?: string;
    /** Allowed CORS origins. Defaults to localhost only. Wildcard "*" is never set unless explicitly listed here. */
    corsOrigins?: string[];
    /** Bearer token required for writable HTTP endpoints (POST/DELETE). */
    authToken?: string;
  };
  contacts?: Record<string, { name: string; channels: Array<{ type: string; id: string; url: string }> }>;
  state?: {
    chatRoutes?: Record<string, { agentName: string; channel?: string; channelUrl?: string }>;
    groups?: Record<string, string[]>;
    targets?: Record<string, { name: string; channelType: string; rawId: string; kind: string }>;
  };
  [key: string]: unknown;
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

// ── Health ───────────────────────────────────────────────────────────────────

export interface HealthSnapshot {
  servers: Array<{ id: string; healthy: boolean; port?: number }>;
  clients: Array<{ url: string; healthy: boolean; channel: string }>;
  agents: { total: number; stale: number };
  uptime: number;
}

export interface UpdateInfo {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
}
