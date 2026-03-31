/**
 * HubFacade — Public interface for ChannelHub.
 *
 * Tools and external consumers should program against this interface
 * rather than reaching into ChannelHub internals. This decouples the
 * tool layer from the hub implementation and makes the public API
 * explicit and discoverable.
 */
import type { RichMessageParams } from "@gettalon/protocol";
import type { GroupMember, TargetEntry, HealthSnapshot, HubHookEvent, HubHookFn, ContactEntry } from "./types.js";

// ── Supporting summary types ─────────────────────────────────────────────

export interface AgentSummary {
  id: string;
  name: string;
  tools: string[];
  lastHeartbeat: number;
}

export interface PendingAgentSummary {
  code: string;
  name: string;
  address: string;
  tools: string[];
  requestedAt: number;
}

export interface TargetSummary {
  uuid: string;
  name: string;
  kind: string;
  channelType: string;
}

export interface ServerSummary {
  id: string;
  type: string;
  port?: number;
}

export interface ContactSummary {
  name: string;
  channels: Array<{ type: string; id: string; url: string }>;
}

// ── The facade interface ─────────────────────────────────────────────────

export interface HubFacade {
  // === Identity & Configuration ===
  readonly name: string;
  readonly defaultPort: number;

  // === Connection Status ===
  isClient(): boolean;
  clientConnected(): boolean;

  // === Agent Management ===
  readonly agents: Map<string, any>;  // Direct access for advanced uses (e.g., iterating agents)
  listAgents(): AgentSummary[] | Promise<AgentSummary[]>;
  findAgent(idOrName: string): { id: string; name: string } | undefined;
  approveAgent(pairingCode: string): Promise<{ ok: boolean; error?: string }>;
  denyAgent(pairingCode: string): { ok: boolean; error?: string };
  listPendingAgents(): PendingAgentSummary[];

  // === Chat Routing ===
  sendMessage(target: string | undefined, content: string, rich?: RichMessageParams): { ok: boolean; error?: string };
  reply(chatId: string, text: string, rich?: RichMessageParams): { ok: boolean; error?: string };
  handover(chatId: string, toAgentId: string): { ok: boolean; error?: string } | Promise<{ ok: boolean; error?: string }>;
  releaseChat(chatId: string): { ok: boolean; error?: string } | Promise<{ ok: boolean; error?: string }>;
  getChatRoutes(): Map<string, string>;

  // === Target Registry ===
  listTargets(): TargetSummary[];
  findTarget(nameOrId: string): TargetEntry | undefined;
  displayName(chatId: string): string;
  resolvedName(rawId?: string): string;

  // === Group Management ===
  listGroups(): Array<{ name: string; members: GroupMember[] }> | Promise<Array<{ name: string; members: GroupMember[] }>>;
  createGroup(name: string): { ok: boolean; error?: string } | Promise<{ ok: boolean; error?: string }>;
  addToGroup(groupName: string, member: string, receiveMode?: "all" | "@only"): { ok: boolean; error?: string } | Promise<{ ok: boolean; error?: string }>;
  removeFromGroup(groupName: string, member: string): { ok: boolean; error?: string } | Promise<{ ok: boolean; error?: string }>;
  deleteGroup(name: string): { ok: boolean; error?: string } | Promise<{ ok: boolean; error?: string }>;
  broadcastToGroup(groupName: string, content: string, from: string): { ok: boolean; sent: number; error?: string } | Promise<{ ok: boolean; sent: number; error?: string }>;

  // === Contact Management ===
  listContacts(): ContactEntry[];
  registerContact(name: string, channelType: string, id: string, url?: string): { ok: boolean };
  removeContact(name: string): { ok: boolean; error?: string };

  // === Settings & Persistence ===
  loadSettings(): Promise<Record<string, any>>;
  loadSettingsSafe(): Promise<Record<string, any>>;
  saveSettings(settings: Record<string, any>): Promise<void>;

  // === Server Control ===
  startServer(port?: number, opts?: { http?: boolean }): Promise<{ port: number }>;
  getServers(): ServerSummary[];
  hasServer(id: string): boolean;
  startHttpWs(port: number): Promise<void>;

  // === Connection Management ===
  readonly clients: Map<string, any>;  // Direct access for advanced uses (e.g., channel clients map)
  connect(url: string, agentName?: string, config?: Record<string, unknown>): Promise<void>;

  // === Tool Execution ===
  callRemoteTool(agentId: string, toolName: string, args: Record<string, unknown>): Promise<unknown>;

  // === Health & Status ===
  getStatus(): Record<string, any> | Promise<Record<string, any>>;
  getHealth(): Promise<HealthSnapshot>;

  // === Auto-Management ===
  autoUpdate(): Promise<{ updated: boolean; currentVersion: string; latestVersion: string; updateAvailable: boolean }>;
  reload(): Promise<{ checks: string[]; issues: string[]; summary: Record<string, number> }>;

  // === Events & Hooks ===
  on(event: string, handler: (...args: any[]) => void): this;
  off(event: string, handler: (...args: any[]) => void): this;
  emit(event: string, ...args: any[]): boolean;
  hook(event: HubHookEvent, handler: HubHookFn): this;

  // === Persistent Agent Router ===
  registerPersistentAgentRouter(handler: (name: string, content: string, from: string, chatId: string) => boolean): void;

  // === Runtime Command Interface ===
  // Called exclusively by hub-runtime to mutate hub-core state.
  // These methods form the explicit boundary between hub-core and hub-runtime;
  // hub-runtime must NOT access core Maps (agents, chatRoutes, etc.) directly.

  /** Register a newly connected agent. */
  registerAgent(id: string, state: import("./types.js").AgentState): void;
  /** Unregister a disconnected agent by ID. */
  unregisterAgent(id: string): void;
  /** Update heartbeat timestamp for an agent. */
  touchAgentHeartbeat(id: string): void;

  /** Add an agent to the pending approval queue. */
  addPendingAgent(code: string, pending: import("./types.js").PendingAgent): void;
  /** Remove an agent from the pending approval queue. */
  removePendingAgent(code: string): void;

  /**
   * Claim ownership of a chat for a specific agent (used during registration/approval).
   * Distinct from handover() which routes between existing active agents.
   */
  claimChat(chatId: string, agentId: string): void;

  /** Register a (channelType, rawId) target pair with a stable UUID. Returns the UUID. */
  registerTarget(name: string, channelType: string, rawId: string, kind: "agent" | "user" | "group" | "channel", sourceUrl?: string): string;
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
}
