/**
 * hub-commands.ts — Command registry for ChannelHub.
 *
 * Provides a slash-command system that channels (Telegram, Discord, etc.)
 * can invoke. Built-in commands:
 *   /hooks on|off   — toggle hook event display
 *   /status         — show hub status summary
 *   /agents         — list connected agents
 *
 * Custom commands can be registered via hub.registerCommand().
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ChannelHub } from "./hub.js";

// ── Types ────────────────────────────────────────────────────────────────────

/** Result of executing a hub command. */
export interface CommandResult {
  /** Text response to send back to the caller. */
  text: string;
  /** Optional format hint for the channel. */
  format?: "text" | "html" | "markdown";
}

/** Handler for a registered hub command. */
export type CommandHandler = (
  hub: ChannelHub,
  arg: string,
  context: { chatId?: string; user?: string },
) => CommandResult | Promise<CommandResult>;

/** Registered command definition. */
export interface CommandDef {
  name: string;
  description: string;
  handler: CommandHandler;
}

// ── Settings I/O for hooks visibility ────────────────────────────────────────

const TALON_SETTINGS_PATH = join(homedir(), ".talon", "settings.json");

export interface TalonSettings {
  hooksVisible?: boolean;
  [key: string]: unknown;
}

export async function loadTalonSettings(): Promise<TalonSettings> {
  try {
    const raw = await readFile(TALON_SETTINGS_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export async function saveTalonSettings(settings: TalonSettings): Promise<void> {
  await mkdir(join(homedir(), ".talon"), { recursive: true });
  let existing: TalonSettings = {};
  try {
    existing = JSON.parse(await readFile(TALON_SETTINGS_PATH, "utf-8"));
  } catch {}
  const merged = { ...existing, ...settings };
  await writeFile(TALON_SETTINGS_PATH, JSON.stringify(merged, null, 2));
}

/** Check if hooks should be displayed (default: true). */
export async function areHooksVisible(): Promise<boolean> {
  const settings = await loadTalonSettings();
  return settings.hooksVisible !== false;
}

/** Set hooks visibility. */
export async function setHooksVisible(visible: boolean): Promise<void> {
  await saveTalonSettings({ hooksVisible: visible });
}

// ── Command Registry ─────────────────────────────────────────────────────────

const registry = new Map<string, CommandDef>();

/** Register a command. Overwrites existing commands with the same name. */
export function registerCommand(def: CommandDef): void {
  registry.set(def.name.toLowerCase(), def);
}

/** Unregister a command. */
export function unregisterCommand(name: string): boolean {
  return registry.delete(name.toLowerCase());
}

/** Get a registered command by name. */
export function getCommand(name: string): CommandDef | undefined {
  return registry.get(name.toLowerCase());
}

/** List all registered commands. */
export function listCommands(): CommandDef[] {
  return [...registry.values()];
}

/** Parse a command string (e.g. "/hooks on") → { name, arg }. */
export function parseHubCommand(text: string): { name: string; arg: string } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  const [firstWord, ...rest] = trimmed.split(/\s+/);
  return {
    name: firstWord.slice(1).toLowerCase(),
    arg: rest.join(" ").trim(),
  };
}

/**
 * Execute a hub command by text string.
 * Returns null if the command is not recognized.
 */
export async function executeCommand(
  hub: ChannelHub,
  text: string,
  context: { chatId?: string; user?: string } = {},
): Promise<CommandResult | null> {
  const parsed = parseHubCommand(text);
  if (!parsed) return null;
  const def = registry.get(parsed.name);
  if (!def) return null;
  return def.handler(hub, parsed.arg, context);
}

// ── Built-in commands ────────────────────────────────────────────────────────

registerCommand({
  name: "hooks",
  description: "Toggle hook event display: /hooks on|off",
  handler: async (_hub, arg) => {
    const lower = arg.toLowerCase();
    if (lower === "on") {
      await setHooksVisible(true);
      return { text: "Hook events: ON — you will see hook lifecycle messages." };
    }
    if (lower === "off") {
      await setHooksVisible(false);
      return { text: "Hook events: OFF — hook lifecycle messages hidden." };
    }
    const current = await areHooksVisible();
    return { text: `Hook events are currently ${current ? "ON" : "OFF"}. Usage: /hooks on|off` };
  },
});

registerCommand({
  name: "status",
  description: "Show hub status summary",
  handler: async (hub) => {
    const status = await Promise.resolve(hub.getStatus());
    const uptime = Math.floor((Date.now() - hub.startedAt) / 1000);
    const lines = [
      `Hub: ${hub.name}`,
      `Uptime: ${uptime}s`,
      `Servers: ${status.servers?.length ?? 0}`,
      `Channels: ${status.clients?.length ?? 0}`,
      `Agents: ${status.agents ?? 0}`,
      `Routes: ${status.chatRoutes ?? 0}`,
    ];
    return { text: lines.join("\n") };
  },
});

registerCommand({
  name: "agents",
  description: "List connected agents",
  handler: async (hub) => {
    const agents = await Promise.resolve(hub.listAgents());
    if (!agents.length) {
      return { text: "No agents connected." };
    }
    const lines = agents.map((a) =>
      `• ${a.name} (tools: ${a.tools.join(", ") || "none"})`,
    );
    return { text: `Connected agents:\n${lines.join("\n")}` };
  },
});

registerCommand({
  name: "targets",
  description: "List addressable targets with UUIDs",
  handler: async (hub) => {
    const registry = (hub as any).targetRegistry as Map<string, any> | undefined;
    if (!registry || !registry.size) {
      return { text: "No targets registered." };
    }
    const lines = [...registry.entries()].map(([uuid, entry]) =>
      `• ${entry.name} (${entry.kind}) uuid:${uuid}`,
    );
    return { text: `Targets:\n${lines.join("\n")}` };
  },
});

registerCommand({
  name: "approve",
  description: "Approve a pending agent: /approve <code>",
  handler: async (hub, arg) => {
    const code = arg?.trim();
    if (!code) {
      const pending = [...((hub as any).pendingAgents as Map<string, any>).entries()]
        .map(([code, p]) => `• ${code} — ${p.name} from ${p.address}`);
      if (!pending.length) return { text: "No pending agents." };
      return { text: `Pending approvals:\n${pending.join("\n")}` };
    }
    const result = await hub.approveAgent(code);
    if (result.ok) {
      return { text: `Approved "${result.name}".` };
    }
    return { text: `Approval failed: ${result.error}` };
  },
});

registerCommand({
  name: "dispatch",
  description: "Call a tool on an agent: /dispatch <agent> <tool> [jsonArgs]",
  handler: async (hub, arg) => {
    const parts = arg?.trim().split(/\s+/) || [];
    if (parts.length < 2) {
      return { text: "Usage: /dispatch <agent> <tool> [jsonArgs]\nExample: /dispatch dexter shell_command '{\"cmd\":\"ls\"}'" };
    }
    const [agentName, toolName, ...argsParts] = parts;
    const argsStr = argsParts.join(" ");
    let args: Record<string, unknown> = {};
    if (argsStr) {
      try {
        args = JSON.parse(argsStr);
      } catch {
        return { text: `Invalid JSON args: ${argsStr}` };
      }
    }

    // Find agent by name
    const agent = [...hub.agents.values()].find((a: any) => a.name === agentName);
    if (!agent) {
      return { text: `Agent "${agentName}" not found. Use /agents to list.` };
    }

    try {
      const result = await hub.callRemoteTool(agent.id, toolName, args);
      const resultStr = typeof result === "object" ? JSON.stringify(result, null, 2) : String(result);
      const truncated = resultStr.length > 2000 ? resultStr.slice(0, 2000) + "...\n[truncated]" : resultStr;
      return { text: `✅ ${toolName}:\n${truncated}` };
    } catch (err: any) {
      return { text: `❌ Error: ${err.message}` };
    }
  },
});

registerCommand({
  name: "call",
  description: "Alias for /dispatch: /call <agent> <tool> [jsonArgs]",
  handler: async (hub, arg, context) => {
    const dispatchCmd = registry.get("dispatch")!;
    return dispatchCmd.handler(hub, arg, context);
  },
});

registerCommand({
  name: "routes",
  description: "Show chat routes (which agent handles which chat)",
  handler: async (hub) => {
    const routes = hub.chatRoutes;
    if (!routes.size) {
      return { text: "No chat routes active." };
    }
    const lines = [...routes.entries()].map(([chatId, agentId]) => {
      const agent = hub.agents.get(agentId as string);
      const agentName = agent?.name || agentId;
      return `• ${chatId} → ${agentName}`;
    });
    return { text: `Chat routes:\n${lines.join("\n")}` };
  },
});

registerCommand({
  name: "ls",
  description: "List all: agents, channels, routes",
  handler: async (hub) => {
    const agents = [...hub.agents.values()];
    const servers = hub.servers;
    const channels = servers.size > 0 ? `${servers.size} server(s)` : "no servers";
    const routes = hub.chatRoutes.size;

    const lines = [
      `📊 Hub: ${hub.name}`,
      ``,
      `🤖 Agents (${agents.length}):`,
      ...agents.map((a: any) => `  • ${a.name}`),
      ``,
      `📡 Channels: ${channels}`,
      `🔀 Routes: ${routes}`,
    ];
    return { text: lines.join("\n") };
  },
});

registerCommand({
  name: "pending",
  description: "List pending agent approvals",
  handler: async (hub) => {
    const pending = [...((hub as any).pendingAgents as Map<string, any>).entries()];
    if (!pending.length) {
      return { text: "No pending approvals." };
    }
    const lines = pending.map(([code, p]) => `• ${code} — ${p.name} from ${p.address}`);
    return { text: `Pending approvals:\n${lines.join("\n")}\n\nUse /approve <code> to approve.` };
  },
});

registerCommand({
  name: "health",
  description: "Show health status",
  handler: async (hub) => {
    const status = await Promise.resolve(hub.getStatus());
    const healthy = status.agents !== undefined;
    return {
      text: healthy
        ? `✅ Healthy\nAgents: ${status.agents}\nServers: ${status.servers?.length ?? 0}`
        : "❌ Hub not responding"
    };
  },
});

// ── Install onto ChannelHub ──────────────────────────────────────────────────

export function installCommands(Hub: typeof ChannelHub): void {
  /** Register a custom command on this hub. */
  Hub.prototype.registerCommand = function (this: ChannelHub, def: CommandDef): void {
    registerCommand(def);
  };

  /** Execute a slash command string. Returns null if not recognized. */
  Hub.prototype.executeCommand = function (
    this: ChannelHub,
    text: string,
    context?: { chatId?: string; user?: string },
  ): Promise<CommandResult | null> {
    return executeCommand(this, text, context);
  };

  /** List all registered commands. */
  Hub.prototype.listCommands = function (this: ChannelHub): CommandDef[] {
    return listCommands();
  };
}
