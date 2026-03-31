/**
 * Persistent Agent Launcher — spawns domain-specific Claude Code agents
 * using the Claude Agent SDK's query() function with streaming input.
 *
 * Each agent gets:
 *   - A dedicated folder: ~/.talon/agents/<name>/
 *   - A CLAUDE.md with identity instructions
 *   - A persistent query() session with streaming input (AsyncQueue)
 *   - MCP config pointing to the talon-architect server
 *   - In-memory tracking via runningAgents map
 *
 * Routing modes:
 *   - "master": routes through the master hub (default)
 *   - "bypass": connects to hub but handles its own routing
 *   - "direct": uses its own bot token (e.g. dedicated Telegram bot)
 */
import { mkdir, writeFile, readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import type { Query, SDKUserMessage, SDKMessage, McpServerConfig } from "@anthropic-ai/claude-agent-sdk";

// ── AsyncQueue ────────────────────────────────────────────────────────────

/**
 * A simple async queue that implements AsyncIterable<T>.
 * Items pushed into the queue are yielded to the async iterator.
 * Calling close() signals the end of the stream.
 */
export class AsyncQueue<T> {
  private queue: T[] = [];
  private resolve?: (value: IteratorResult<T>) => void;
  private closed = false;

  push(item: T): void {
    if (this.closed) return;
    if (this.resolve) {
      const r = this.resolve;
      this.resolve = undefined;
      r({ value: item, done: false });
    } else {
      this.queue.push(item);
    }
  }

  close(): void {
    this.closed = true;
    if (this.resolve) {
      const r = this.resolve;
      this.resolve = undefined;
      r({ value: undefined as any, done: true });
    }
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get length(): number {
    return this.queue.length;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    while (true) {
      if (this.queue.length > 0) {
        yield this.queue.shift()!;
      } else if (this.closed) {
        return;
      } else {
        const result = await new Promise<IteratorResult<T>>((resolve) => {
          this.resolve = resolve;
        });
        if (result.done) return;
        yield result.value;
      }
    }
  }
}

// ── API Provider Presets ──────────────────────────────────────────────────

export interface ApiProviderConfig {
  baseUrl: string;
  authToken?: string;
  model?: string;
  smallModel?: string;
}

/** Built-in API provider presets. */
const BUILTIN_API_PROVIDERS: Record<string, ApiProviderConfig> = {
  anthropic: { baseUrl: "https://api.anthropic.com", model: "claude-sonnet-4-6", smallModel: "claude-haiku-4-5" },
  glm: { baseUrl: "https://api.z.ai/api/anthropic", model: "glm-5", smallModel: "glm-4.7-air" },
  deepseek: { baseUrl: "https://api.deepseek.com", model: "deepseek-chat", smallModel: "deepseek-chat" },
  ark: { baseUrl: "https://ark.cn-beijing.volces.com/api/v3", model: "doubao-pro-32k", smallModel: "doubao-lite-4k" },
  openrouter: { baseUrl: "https://openrouter.ai/api/v1", model: "anthropic/claude-sonnet-4", smallModel: "anthropic/claude-haiku-4" },
};

/** Load API provider presets from ~/.talon/settings.json (shared with ai-dispatch, switch_env). */
function loadApiProviders(): Record<string, ApiProviderConfig> {
  try {
    const settings = JSON.parse(readFileSync(join(homedir(), ".talon", "settings.json"), "utf-8"));
    // Merge built-in with user overrides (user settings take precedence)
    return { ...BUILTIN_API_PROVIDERS, ...settings.apiProviders };
  } catch {
    return { ...BUILTIN_API_PROVIDERS };
  }
}

/**
 * Quick check if an API key exists (env + settings only, no Keychain).
 * Use for listing/display — never triggers macOS permission prompts.
 */
function hasApiKey(provider: string): boolean {
  if (process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY) return true;
  try {
    const settings = JSON.parse(readFileSync(join(homedir(), ".talon", "settings.json"), "utf-8"));
    if (settings.apiKeys?.[provider]) return true;
  } catch {}
  return false;
}

/**
 * Load API key for a provider. Full resolution including Keychain.
 * Only call when actually dispatching an agent.
 *
 * Resolution order:
 * 1. Environment variable ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY
 * 2. ~/.talon/settings.json apiKeys.{provider}
 * 3. macOS Keychain (security find-generic-password -s "talon-{provider}")
 */
function loadApiKey(provider: string): string | undefined {
  // 1. Environment (fastest, no side effects)
  const envKey = process.env.ANTHROPIC_AUTH_TOKEN ?? process.env.ANTHROPIC_API_KEY;
  if (envKey) return envKey;
  // 2. Settings file
  try {
    const settings = JSON.parse(readFileSync(join(homedir(), ".talon", "settings.json"), "utf-8"));
    const key = settings.apiKeys?.[provider];
    if (key) return key;
  } catch {}
  // 3. macOS Keychain (only when actually needed)
  if (process.platform === "darwin") {
    try {
      const { execSync } = require("node:child_process");
      const key = execSync(`security find-generic-password -s "talon-${provider}" -w 2>/dev/null`, { encoding: "utf-8" }).trim();
      if (key) return key;
    } catch {}
  }
  return undefined;
}

/**
 * Store an API key in the best available backend.
 * macOS: Keychain. Others: ~/.talon/settings.json
 */
export function storeApiKey(provider: string, key: string): { stored: string } {
  if (process.platform === "darwin") {
    try {
      const { execSync } = require("node:child_process");
      // Delete existing entry (ignore errors)
      try { execSync(`security delete-generic-password -s "talon-${provider}" 2>/dev/null`); } catch {}
      execSync(`security add-generic-password -s "talon-${provider}" -a "talon" -w "${key}"`);
      return { stored: "keychain" };
    } catch {}
  }
  // Fallback: settings.json
  try {
    const settingsPath = join(homedir(), ".talon", "settings.json");
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    if (!settings.apiKeys) settings.apiKeys = {};
    settings.apiKeys[provider] = key;
    const { writeFileSync: wfs } = require("node:fs");
    wfs(settingsPath, JSON.stringify(settings, null, 2));
    return { stored: "settings.json" };
  } catch {}
  return { stored: "failed" };
}

/** Cached providers — reloaded each launch to pick up settings changes. */
export let API_PROVIDERS: Record<string, ApiProviderConfig> = {};

// ── Types ──────────────────────────────────────────────────────────────────

/** Callback invoked when a persistent agent produces output text. */
export type AgentOutputCallback = (agentName: string, text: string, chatId?: string) => void;

/** Maximum number of log entries kept per agent */
const MAX_AGENT_LOGS = 50;

export interface PersistentAgent {
  name: string;           // e.g. "dexter", "polymarket"
  folder: string;         // e.g. ~/.talon/agents/dexter/
  pid?: number;           // kept for backward compat; undefined for SDK-based agents
  status: "running" | "stopped" | "error";
  mode: "master" | "bypass" | "direct"; // routing mode
  botToken?: string;      // for direct mode (own Telegram bot)
  hubUrl?: string;        // WS URL to connect to hub (default ws://localhost:9090)
  startedAt?: string;
  /** The running Query instance (in-memory only, not serialized) */
  query?: Query;
  /** Push a message to the agent's input queue */
  sendMessage?: (text: string, from?: string, chatId?: string) => void;
  /** Last chat ID that sent a message to this agent — used for reply routing */
  lastChatId?: string;
  /** Callback for agent output */
  onOutput?: AgentOutputCallback;
  /** Why the agent exited: "completed" or "error: <message>" */
  exitReason?: string;
  /** Ring buffer of recent output log entries (max MAX_AGENT_LOGS) */
  logs?: string[];
}

export interface LaunchAgentOptions {
  mode?: "master" | "bypass" | "direct";
  prompt?: string;
  botToken?: string;
  hubUrl?: string;
  mcpServers?: Record<string, McpServerConfig>;
  /** Called when the agent produces output text — wire this to route replies back to channels */
  onOutput?: AgentOutputCallback;
  /** Working directory for the agent (defaults to agent folder) */
  cwd?: string;
  /** Additional directories the agent can access */
  additionalDirectories?: string[];
  /** API provider preset name (e.g. "glm", "anthropic", "deepseek", "ark", "openrouter") */
  apiProvider?: string;
  /** Custom API base URL (overrides provider preset) */
  apiBaseUrl?: string;
  /** API auth token/key (overrides provider preset or inherits from environment) */
  apiToken?: string;
  /** AI model name (overrides provider preset) */
  model?: string;
  /** Small/fast model for non-critical tasks */
  smallModel?: string;
  /** Fallback model if primary unavailable */
  fallbackModel?: string;
  /** Tools auto-allowed without approval */
  allowedTools?: string[];
  /** Tools blocked from use */
  disallowedTools?: string[];
  /** Base toolset — array of tool names, or empty [] to disable all */
  tools?: string[];
  /** Agent definition name to use */
  agent?: string;
  /** Sub-agent definitions available to this agent */
  agents?: Record<string, { description: string; prompt: string; tools?: string[] }>;
  /** Hooks callbacks */
  hooks?: boolean;
  /** Save session to disk */
  persistSession?: boolean;
  /** Enable file checkpointing for rewind */
  enableFileCheckpointing?: boolean;
  /** Path to agent.smith.md template (overrides default CLAUDE.md) */
  template?: string;
  /** Replace the default system prompt entirely */
  systemPrompt?: string;
  /** Append to the default system prompt (identity prompt goes here by default) */
  appendSystemPrompt?: string;
  /** Permission mode: bypassPermissions (default), default, plan */
  permissionMode?: string;
}

// ── Constants ──────────────────────────────────────────────────────────────

const AGENTS_DIR = join(homedir(), ".talon", "agents");

// ── Running agents (in-memory) ─────────────────────────────────────────────

const runningAgents = new Map<string, PersistentAgent>();

/** Messages buffered for stopped agents, flushed on relaunch. Max 100 per agent. */
const agentMessageBuffer = new Map<string, Array<{ text: string; from?: string; chatId?: string }>>();
const MAX_AGENT_BUFFER = 100;

// ── Helpers ────────────────────────────────────────────────────────────────

export function agentFolder(name: string): string {
  return join(AGENTS_DIR, name);
}

async function ensureAgentDir(name: string): Promise<string> {
  const dir = agentFolder(name);
  await mkdir(dir, { recursive: true });
  return dir;
}

async function readAgentMeta(name: string): Promise<Partial<PersistentAgent>> {
  try {
    const raw = await readFile(join(agentFolder(name), "agent.json"), "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function writeAgentMeta(name: string, meta: Partial<PersistentAgent>): Promise<void> {
  // Strip non-serializable fields before writing
  const { query: _q, sendMessage: _s, ...serializable } = meta;
  await writeFile(join(agentFolder(name), "agent.json"), JSON.stringify(serializable, null, 2));
}

// ── Resolve MCP server path ───────────────────────────────────────────────

function resolveMcpServerPath(): string {
  // Agents use agent-server.js (lightweight, Unix socket only)
  // Falls back to server.js (full architect) if agent-server.js not found
  const serverNames = ["agent-server.js", "server.js"];
  const cacheRoots = [
    join(homedir(), ".claude", "plugins", "cache", "talon-private-plugins", "talon-architect"),
    join(homedir(), ".claude", "plugins", "cache", "talon-private-plugins", "talon-edge-agent"),
  ];
  for (const root of cacheRoots) {
    if (!existsSync(root)) continue;
    const versions = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => {
        const aParts = a.split(".").map((part) => parseInt(part, 10) || 0);
        const bParts = b.split(".").map((part) => parseInt(part, 10) || 0);
        const maxLen = Math.max(aParts.length, bParts.length);
        for (let i = 0; i < maxLen; i += 1) {
          const diff = (bParts[i] ?? 0) - (aParts[i] ?? 0);
          if (diff !== 0) return diff;
        }
        return 0;
      });
    for (const version of versions) {
      for (const serverName of serverNames) {
        const candidate = join(root, version, "mcp-server", serverName);
        if (existsSync(candidate)) return candidate;
      }
    }
  }

  // Fall back to the dist/architect.js in this package
  const selfDir = new URL(".", import.meta.url).pathname;
  const distPath = join(selfDir, "..", "architect.js");
  if (existsSync(distPath)) return distPath;

  // Last resort
  return join(
    homedir(),
    ".claude",
    "plugins",
    "cache",
    "talon-private-plugins",
    "talon-architect",
    "0.4.0",
    "mcp-server",
    "agent-server.js",
  );
}

/** Remove old cached versions, keeping only the latest one. */
export function cleanupStaleVersions(): { removed: string[]; kept: string } {
  const removed: string[] = [];
  let kept = "";
  const cacheRoots = [
    join(homedir(), ".claude", "plugins", "cache", "talon-private-plugins", "talon-architect"),
    join(homedir(), ".claude", "plugins", "cache", "talon-private-plugins", "talon-edge-agent"),
  ];
  for (const root of cacheRoots) {
    if (!existsSync(root)) continue;
    const versions = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => {
        const aParts = a.split(".").map((part) => parseInt(part, 10) || 0);
        const bParts = b.split(".").map((part) => parseInt(part, 10) || 0);
        const maxLen = Math.max(aParts.length, bParts.length);
        for (let i = 0; i < maxLen; i += 1) {
          const diff = (bParts[i] ?? 0) - (aParts[i] ?? 0);
          if (diff !== 0) return diff;
        }
        return 0;
      });
    if (versions.length <= 1) { if (versions[0]) kept = versions[0]; continue; }
    kept = versions[0]; // latest
    for (let i = 1; i < versions.length; i++) {
      const vPath = join(root, versions[i]);
      try { rmSync(vPath, { recursive: true, force: true }); removed.push(`${root}/${versions[i]}`); }
      catch {}
    }
  }
  return { removed, kept };
}

// ── Default CLAUDE.md content ──────────────────────────────────────────────
// Embedded copy of templates/agent.smith.md — keep in sync
const AGENT_SMITH_TEMPLATE = `# AGENTS.md — {{name}} Agent Protocol

## 1) Agent Identity

Name: {{name}}
Mode: {{mode}}
Hub: {{hub_url}}
Working Directory: {{folder}}

{{identity}}

## 2) Communication Rules (CRITICAL)

- SILENT MODE: Do NOT send progress messages. No "reading file", "now implementing", "let me check" messages.
- ONLY send messages for: final result, errors that block you, or questions that need human input.
- ONE message per task: a short summary when done. Not one message per step.
- Use talon-architect MCP tools (reply, send, call_tool) to communicate.

## 3) Engineering Principles (Mandatory)

### KISS
- Prefer straightforward control flow over meta-programming
### YAGNI
- Do not add speculative abstractions
### Fail Fast
- Return explicit errors; never swallow failures silently

## 4) Working Protocol (Required)

1. Read before write
2. One concern per change
3. Implement minimal patch
4. Validate: npm run build && npx vitest run
5. Commit — post-commit hook syncs to cache

## 5) Anti-Patterns (DO NOT)

- Do not narrate every step
- Do not edit ~/.claude/plugins/cache/ — edit source, commit
- Do not start channels — you are a client
- Do not use git add . — stage specific files
`;

function defaultClaudeMd(name: string, identity: string, mode: string, modeDesc: string, hubUrl: string, folder: string): string {
  return AGENT_SMITH_TEMPLATE
    .replace(/\{\{name\}\}/g, name)
    .replace(/\{\{identity\}\}/g, identity)
    .replace(/\{\{mode\}\}/g, `${mode}\n${modeDesc}`)
    .replace(/\{\{hub_url\}\}/g, hubUrl)
    .replace(/\{\{folder\}\}/g, folder);
}

// ── Create SDKUserMessage from text ───────────────────────────────────────

function textToUserMessage(text: string, from?: string): SDKUserMessage {
  const content = from ? `[from: ${from}] ${text}` : text;
  return {
    type: "user",
    message: { role: "user", content },
    parent_tool_use_id: null,
  };
}

// ── Query factory (injectable for testing) ────────────────────────────────

type QueryFactory = (params: {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options?: Record<string, any>;
}) => Query;

let queryFn: QueryFactory | null = null;

/** Override the query factory (for testing). */
export function _setQueryFactory(fn: QueryFactory): void {
  queryFn = fn;
}

/** Reset the query factory to use the real SDK. */
export function _resetQueryFactory(): void {
  queryFn = null;
}

async function getQueryFn(): Promise<QueryFactory> {
  if (queryFn) return queryFn;
  const sdk = await import("@anthropic-ai/claude-agent-sdk");
  return sdk.query;
}

// ── Launch ─────────────────────────────────────────────────────────────────

export async function launchAgent(
  name: string,
  opts: LaunchAgentOptions = {},
): Promise<PersistentAgent> {
  const mode = opts.mode ?? "master";
  const hubUrl = opts.hubUrl ?? "ws://localhost:9090";

  // If already running in-memory, return the handle
  const existing = runningAgents.get(name);
  if (existing && existing.status === "running") {
    return existing;
  }

  // 1. Create the agent folder
  const dir = await ensureAgentDir(name);

  // 2. Write CLAUDE.md from agent.smith.md template or defaults
  const identity = opts.prompt ?? `You are the "${name}" agent. You have persistent memory via --continue. Use the talon-architect MCP tools to communicate with other agents and channels.`;
  const modeDesc = mode === "direct" ? "You have your own Telegram bot token for direct channel access." : "You route through the master hub.";

  let claudeMd: string;
  if (opts.template) {
    try {
      const tpl = await readFile(opts.template, "utf-8");
      claudeMd = tpl
        .replace(/\{\{name\}\}/g, name)
        .replace(/\{\{identity\}\}/g, identity)
        .replace(/\{\{mode\}\}/g, mode)
        .replace(/\{\{mode_description\}\}/g, modeDesc)
        .replace(/\{\{hub_url\}\}/g, hubUrl)
        .replace(/\{\{folder\}\}/g, dir);
    } catch {
      claudeMd = defaultClaudeMd(name, identity, mode, modeDesc, hubUrl, dir);
    }
  } else {
    // Try templates/agent.smith.md from SDK root
    const smithPath = join(new URL(".", import.meta.url).pathname, "..", "templates", "agent.smith.md");
    try {
      const tpl = await readFile(smithPath, "utf-8");
      claudeMd = tpl
        .replace(/\{\{name\}\}/g, name)
        .replace(/\{\{identity\}\}/g, identity)
        .replace(/\{\{mode\}\}/g, mode)
        .replace(/\{\{mode_description\}\}/g, modeDesc)
        .replace(/\{\{hub_url\}\}/g, hubUrl)
        .replace(/\{\{folder\}\}/g, dir);
    } catch {
      claudeMd = defaultClaudeMd(name, identity, mode, modeDesc, hubUrl, dir);
    }
  }
  // Include SOUL.md if it exists (agent identity / personality / domain expertise)
  const soulPath = join(dir, "SOUL.md");
  try {
    const soul = await readFile(soulPath, "utf-8");
    if (soul.trim()) claudeMd = soul.trim() + "\n\n" + claudeMd;
  } catch {}

  // Only write CLAUDE.md on first launch — don't overwrite user customizations
  if (!existsSync(join(dir, "CLAUDE.md"))) {
    await writeFile(join(dir, "CLAUDE.md"), claudeMd);
  }


  // 2b. Write agent.md with config (tools, permissions, directories)
  const resolvedApiProvider = opts.apiProvider ?? "inherited";
  const agentMd = `# ${name}

## Config
- Mode: ${mode}
- Hub: ${hubUrl}
- CWD: ${opts.cwd ?? dir}
- Additional dirs: ${(opts.additionalDirectories ?? []).join(", ") || "none"}

## API Provider
- Provider: ${resolvedApiProvider}
- Base URL: ${opts.apiBaseUrl ?? (API_PROVIDERS[opts.apiProvider ?? ""]?.baseUrl ?? "inherited")}
- Model: ${opts.model ?? (API_PROVIDERS[opts.apiProvider ?? ""]?.model ?? "default")}
- Small Model: ${opts.smallModel ?? (API_PROVIDERS[opts.apiProvider ?? ""]?.smallModel ?? "default")}

## Tools
- Allowed: ${(opts.allowedTools ?? []).join(", ") || "all"}
- Disallowed: ${(opts.disallowedTools ?? []).join(", ") || "none"}
- Base: ${(opts.tools ?? []).join(", ") || "default"}

## MCP Servers
${Object.keys(opts.mcpServers ?? {}).map(s => `- ${s}`).join("\n") || "- talon-architect (default)"}
`;
  await writeFile(join(dir, "agent.md"), agentMd);

  // 3. Build MCP server config
  const mcpServerPath = resolveMcpServerPath();
  const mcpServers: Record<string, McpServerConfig> = {
    "talon-architect": {
      type: "stdio",
      command: "node",
      args: [mcpServerPath],
      env: {
        TALON_AGENT_NAME: name,
        TALON_HUB_URL: hubUrl,
        ...(opts.botToken ? { TELEGRAM_BOT_TOKEN: opts.botToken } : {}),
      },
    },
    ...opts.mcpServers,
  };

  // 4. Create async queue for streaming input
  const inputQueue = new AsyncQueue<SDKUserMessage>();
  const hasExistingSession = existsSync(join(dir, ".claude", "conversations"));

  // Fresh agent needs a kickoff message with identity; continuing agent already has context
  if (!hasExistingSession) {
    inputQueue.push(textToUserMessage(identity));
  }

  // 5. Resolve API provider config from ~/.talon/settings.json
  API_PROVIDERS = loadApiProviders();
  const resolvedProvider: Partial<ApiProviderConfig> = {};
  if (opts.apiProvider) {
    const preset = API_PROVIDERS[opts.apiProvider];
    if (preset) Object.assign(resolvedProvider, preset);
    // Load API key from settings (shared with ai-dispatch, switch_env)
    const key = loadApiKey(opts.apiProvider);
    if (key && !resolvedProvider.authToken) resolvedProvider.authToken = key;
  }
  // Explicit options override presets
  if (opts.apiBaseUrl) resolvedProvider.baseUrl = opts.apiBaseUrl;
  if (opts.apiToken) resolvedProvider.authToken = opts.apiToken;
  if (opts.model) resolvedProvider.model = opts.model;
  if (opts.smallModel) resolvedProvider.smallModel = opts.smallModel;

  // 6. Build environment
  const env: Record<string, string | undefined> = { ...process.env };
  if (opts.botToken) {
    env.TELEGRAM_BOT_TOKEN = opts.botToken;
  }
  env.TALON_AGENT_NAME = name;
  env.TALON_HUB_URL = hubUrl;

  // Apply API provider env vars
  if (resolvedProvider.baseUrl) {
    env.ANTHROPIC_BASE_URL = resolvedProvider.baseUrl;
  }
  if (resolvedProvider.authToken) {
    env.ANTHROPIC_AUTH_TOKEN = resolvedProvider.authToken;
  }
  if (resolvedProvider.model) {
    env.ANTHROPIC_MODEL = resolvedProvider.model;
  }
  if (resolvedProvider.smallModel) {
    env.ANTHROPIC_SMALL_FAST_MODEL = resolvedProvider.smallModel;
  }

  // 6. Start query() with streaming input
  const factory = await getQueryFn();
  const q = factory({
    prompt: inputQueue,
    options: {
      cwd: opts.cwd ?? dir,
      continueConversation: existsSync(join(dir, ".claude", "conversations")),
      ...(opts.systemPrompt ? { systemPrompt: opts.systemPrompt } : {}),
      appendSystemPrompt: [
        opts.appendSystemPrompt ?? identity,
        // Append shared TALON.md if it exists
        (() => { try { return readFileSync(join(homedir(), ".talon", "TALON.md"), "utf-8"); } catch { return ""; } })(),
      ].filter(Boolean).join("\n\n"),
      permissionMode: opts.permissionMode ?? "bypassPermissions",
      allowDangerouslySkipPermissions: (opts.permissionMode ?? "bypassPermissions") === "bypassPermissions",
      additionalDirectories: [dir, ...(opts.additionalDirectories ?? [])],
      mcpServers,
      env,
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.fallbackModel ? { fallbackModel: opts.fallbackModel } : {}),
      ...(opts.allowedTools ? { allowedTools: opts.allowedTools } : {}),
      ...(opts.disallowedTools ? { disallowedTools: opts.disallowedTools } : {}),
      ...(opts.tools ? { tools: opts.tools } : {}),
      ...(opts.agent ? { agent: opts.agent } : {}),
      ...(opts.agents ? { agents: opts.agents } : {}),
      ...(opts.hooks !== undefined ? { hooks: opts.hooks } : {}),
      ...(opts.persistSession !== undefined ? { persistSession: opts.persistSession } : {}),
      ...(opts.enableFileCheckpointing ? { enableFileCheckpointing: opts.enableFileCheckpointing } : {}),
    },
  });

  // 7. Build the agent handle
  const startedAt = new Date().toISOString();
  const agent: PersistentAgent = {
    name,
    folder: dir,
    status: "running",
    mode,
    botToken: opts.botToken,
    hubUrl,
    startedAt,
    query: q,
    onOutput: opts.onOutput,
    sendMessage: (text: string, from?: string, chatId?: string) => {
      if (chatId) agent.lastChatId = chatId;
      inputQueue.push(textToUserMessage(text, from));
    },
  };

  runningAgents.set(name, agent);

  // 8b. Flush any messages buffered while the agent was stopped
  const buffered = agentMessageBuffer.get(name);
  if (buffered && buffered.length > 0) {
    process.stderr.write(`[agent-launcher] Flushing ${buffered.length} buffered message(s) to "${name}"\n`);
    for (const msg of buffered) {
      inputQueue.push(textToUserMessage(msg.text, msg.from));
      if (msg.chatId) agent.lastChatId = msg.chatId;
    }
    agentMessageBuffer.delete(name);
  }

  // 9. Write metadata (non-serializable fields stripped automatically)
  //    Include launch opts for auto-relaunch support.
  await writeAgentMeta(name, {
    name,
    folder: dir,
    status: "running",
    mode,
    botToken: opts.botToken,
    hubUrl,
    startedAt,
    // Persist launch config for auto-relaunch
    prompt: opts.prompt,
    cwd: opts.cwd,
    additionalDirectories: opts.additionalDirectories,
    apiProvider: opts.apiProvider,
    apiBaseUrl: resolvedProvider.baseUrl,
    apiToken: opts.apiToken,
    model: resolvedProvider.model,
    smallModel: resolvedProvider.smallModel,
    fallbackModel: opts.fallbackModel,
    allowedTools: opts.allowedTools,
    disallowedTools: opts.disallowedTools,
  } as any);

  // Initialize logs ring buffer
  agent.logs = [];

  // 10. Consume query output in the background — forward assistant text to onOutput
  (async () => {
    let exitReason = "completed";
    try {
      for await (const msg of q) {
        // Forward assistant text messages back through onOutput callback
        if (agent.onOutput && msg.type === "assistant" && msg.message?.content) {
          const content = msg.message.content;
          let text = "";
          if (typeof content === "string") {
            text = content;
          } else if (Array.isArray(content)) {
            text = content
              .filter((b: any) => b.type === "text")
              .map((b: any) => b.text)
              .join("");
          }
          if (text.trim()) {
            // Push to logs ring buffer
            if (agent.logs!.length >= MAX_AGENT_LOGS) agent.logs!.shift();
            agent.logs!.push(`[${new Date().toISOString()}] ${text}`);
            try {
              agent.onOutput(name, text, agent.lastChatId);
            } catch {}
          }
        }

        // Emit activity notifications for tool use (tool_use blocks inside assistant messages)
        if (msg.type === "assistant" && msg.message?.content && Array.isArray(msg.message.content)) {
          for (const block of msg.message.content) {
            if ((block as any).type === "tool_use") {
              const toolName = (block as any).name ?? "unknown";
              // Push tool activity to logs
              if (agent.logs!.length >= MAX_AGENT_LOGS) agent.logs!.shift();
              agent.logs!.push(`[${new Date().toISOString()}] [tool_use] ${toolName}`);
            }
          }
        }
      }
    } catch (err) {
      exitReason = `error: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      agent.status = "stopped";
      agent.exitReason = exitReason;
      inputQueue.close();
      const stored = runningAgents.get(name);
      if (stored === agent) {
        stored.status = "stopped";
        stored.exitReason = exitReason;
        stored.query = undefined;
        stored.sendMessage = undefined;
      }
      await writeAgentMeta(name, { ...agent, status: "stopped", exitReason, query: undefined, sendMessage: undefined }).catch(() => {});
    }
  })();

  return agent;
}

// ── Send to Agent ──────────────────────────────────────────────────────────

export function sendToAgent(name: string, text: string, from?: string, chatId?: string): { sent: boolean; buffered?: boolean; error?: string } {
  const agent = runningAgents.get(name);
  if (agent && agent.status === "running" && agent.sendMessage) {
    agent.sendMessage(text, from, chatId);
    return { sent: true };
  }
  // Agent not running — buffer the message for delivery on relaunch
  let queue = agentMessageBuffer.get(name);
  if (!queue) {
    queue = [];
    agentMessageBuffer.set(name, queue);
  }
  if (queue.length >= MAX_AGENT_BUFFER) {
    queue.shift(); // drop oldest
  }
  queue.push({ text, from, chatId });
  process.stderr.write(`[agent-launcher] Buffered message for stopped agent "${name}" (${queue.length} queued)\n`);
  return { sent: false, buffered: true };
}

// ── Stop ───────────────────────────────────────────────────────────────────

export async function stopAgent(name: string): Promise<{ stopped: boolean; error?: string }> {
  const agent = runningAgents.get(name);
  if (!agent || agent.status !== "running") {
    return { stopped: false, error: `Agent "${name}" is not running` };
  }

  try {
    if (agent.query) {
      // Try graceful interrupt, then close
      try {
        await agent.query.interrupt();
      } catch {
        // interrupt may fail if already stopped
      }
      agent.query.close();
    }
    agent.status = "stopped";
    agent.exitReason = "stopped";
    agent.query = undefined;
    agent.sendMessage = undefined;

    await writeAgentMeta(name, { ...agent, status: "stopped", exitReason: "stopped" });
    return { stopped: true };
  } catch (e) {
    return { stopped: false, error: String(e) };
  }
}

// ── List ───────────────────────────────────────────────────────────────────

export async function listRunningAgents(): Promise<PersistentAgent[]> {
  const agents: PersistentAgent[] = [];

  // Include all in-memory agents
  for (const agent of runningAgents.values()) {
    agents.push({
      name: agent.name,
      folder: agent.folder,
      status: agent.status,
      mode: agent.mode,
      botToken: agent.botToken,
      hubUrl: agent.hubUrl,
      startedAt: agent.startedAt,
      exitReason: agent.exitReason,
    });
  }

  // Also scan disk for agents not in memory (from previous sessions)
  try {
    const entries = await readdir(AGENTS_DIR);
    for (const entry of entries) {
      if (runningAgents.has(entry)) continue; // already included
      const dir = join(AGENTS_DIR, entry);
      try {
        const s = await stat(dir);
        if (!s.isDirectory()) continue;
      } catch { continue; }

      const meta = await readAgentMeta(entry);
      agents.push({
        name: entry,
        folder: dir,
        status: "stopped",
        mode: (meta.mode as PersistentAgent["mode"]) ?? "master",
        botToken: meta.botToken,
        hubUrl: meta.hubUrl,
        startedAt: meta.startedAt,
      });
    }
  } catch {
    // AGENTS_DIR doesn't exist yet
  }

  return agents;
}

// ── Get Agent ──────────────────────────────────────────────────────────────

export function getAgent(name: string): PersistentAgent | undefined {
  return runningAgents.get(name);
}

// ── Status ─────────────────────────────────────────────────────────────────

export async function getAgentStatus(name: string): Promise<PersistentAgent> {
  // Check in-memory first
  const agent = runningAgents.get(name);
  if (agent) {
    return {
      name: agent.name,
      folder: agent.folder,
      status: agent.status,
      mode: agent.mode,
      botToken: agent.botToken,
      hubUrl: agent.hubUrl,
      startedAt: agent.startedAt,
      exitReason: agent.exitReason,
    };
  }

  // Fall back to disk metadata
  const dir = agentFolder(name);
  const meta = await readAgentMeta(name);
  return {
    name,
    folder: dir,
    status: "stopped",
    mode: (meta.mode as PersistentAgent["mode"]) ?? "master",
    botToken: meta.botToken,
    hubUrl: meta.hubUrl,
    startedAt: meta.startedAt,
    exitReason: (meta as any).exitReason,
  };
}

// ── Clear (for testing) ───────────────────────────────────────────────────

/** Clear all running agents from memory (for testing). */
export function _clearRunningAgents(): void {
  for (const agent of runningAgents.values()) {
    if (agent.query) {
      try { agent.query.close(); } catch {}
    }
  }
}

// ── ToolDefinition exports (for registry) ───────────────────────────────────
import type { ToolDefinition } from "./types.js";

export const launchAgentTool: ToolDefinition = {
  name: "launch_agent",
  description: "Launch a persistent domain-specific Claude Code agent with its own folder and --continue memory. Supports third-party AI APIs via api_provider preset or custom api_base_url/api_key.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Agent name (e.g. dexter, polymarket)" },
      mode: { type: "string", enum: ["master", "bypass", "direct"], description: "Routing mode: master (hub), bypass (self-route), direct (own bot)" },
      prompt: { type: "string", description: "Identity/system prompt for the agent" },
      cwd: { type: "string", description: "Working directory for the agent" },
      additional_directories: { type: "array", items: { type: "string" }, description: "Additional directories the agent can access" },
      bot_token: { type: "string", description: "Telegram bot token for direct mode" },
      api_provider: { type: "string", description: "API provider preset: anthropic, glm, deepseek, ark, openrouter" },
      api_base_url: { type: "string", description: "Custom API base URL (overrides provider preset)" },
      api_key: { type: "string", description: "API auth token/key (overrides provider preset)" },
      model: { type: "string", description: "AI model name (overrides provider preset)" },
      small_model: { type: "string", description: "Small/fast model for non-critical tasks" },
      system_prompt: { type: "string", description: "Replace the default system prompt entirely" },
      append_system_prompt: { type: "string", description: "Append to the default system prompt" },
      permission_mode: { type: "string", description: "Permission mode: bypassPermissions (default), default, plan" },
    },
    required: ["name"],
  },
  handle: async (args, ctx) => {
    const result = await launchAgent(args.name as string, {
      mode: args.mode as any,
      prompt: args.prompt as string | undefined,
      botToken: args.bot_token as string | undefined,
      cwd: args.cwd as string | undefined,
      additionalDirectories: args.additional_directories as string[] | undefined,
      apiProvider: args.api_provider as string | undefined,
      apiBaseUrl: args.api_base_url as string | undefined,
      apiToken: args.api_key as string | undefined,
      model: args.model as string | undefined,
      smallModel: args.small_model as string | undefined,
      systemPrompt: args.system_prompt as string | undefined,
      appendSystemPrompt: args.append_system_prompt as string | undefined,
      permissionMode: args.permission_mode as string | undefined,
      onOutput: (agentName, text, chatId) => {
        if (chatId) ctx.hub.reply(chatId, `[${agentName}] ${text}`);
        ctx.hub.emit("message", { content: `[${agentName}] ${text}`, chatId: chatId ?? "host", user: agentName, type: "chat", source: ctx.serverName });
      },
    });
    return JSON.stringify(result, null, 2);
  },
};

export const stopAgentTool: ToolDefinition = {
  name: "stop_agent",
  description: "Stop a running persistent agent",
  inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
  handle: async (args) => JSON.stringify(await stopAgent(args.name as string), null, 2),
};

export const listRunningAgentsTool: ToolDefinition = {
  name: "list_running_agents",
  description: "List all persistent agents and their status",
  inputSchema: { type: "object", properties: {}, required: [] },
  handle: async () => JSON.stringify(await listRunningAgents(), null, 2),
};

export const sendToAgentTool: ToolDefinition = {
  name: "send_to_agent",
  description: "Send a message to a persistent agent (pushes to its input queue, unlike send_message which routes via hub WebSocket)",
  inputSchema: { type: "object", properties: { name: { type: "string" }, text: { type: "string" }, chat_id: { type: "string" } }, required: ["name", "text"] },
  handle: async (args) => JSON.stringify(sendToAgent(args.name as string, args.text as string, undefined, args.chat_id as string | undefined), null, 2),
};

export function getAgentLogs(name: string): { logs: string[]; exitReason?: string; error?: string } {
  const agent = runningAgents.get(name);
  if (agent) {
    return { logs: agent.logs ?? [], exitReason: agent.exitReason };
  }
  return { logs: [], error: `Agent "${name}" is not running (logs are in-memory only)` };
}

export const agentLogsTool: ToolDefinition = {
  name: "agent_logs",
  description: "Retrieve recent output logs for a named agent (last 50 messages). Also shows exit reason if the agent has stopped.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Agent name" },
    },
    required: ["name"],
  },
  handle: async (args) => JSON.stringify(getAgentLogs(args.name as string), null, 2),
};

export const listApiProvidersTool: ToolDefinition = {
  name: "list_api_providers",
  description: "List available API provider presets for launching agents (glm, anthropic, deepseek, ark, openrouter, etc.)",
  inputSchema: { type: "object", properties: {}, required: [] },
  handle: async () => {
    const allProviders = loadApiProviders();
    const keys = Object.keys(loadApiProviders());
    const providers: Record<string, { baseUrl: string; model: string; smallModel: string; hasKey: boolean }> = {};
    for (const [name, config] of Object.entries(allProviders)) {
      providers[name] = {
        baseUrl: config.baseUrl,
        model: config.model || "(required)",
        smallModel: config.smallModel || "(required)",
        hasKey: hasApiKey(name),
      };
    }
    return JSON.stringify(providers, null, 2);
  },
};
