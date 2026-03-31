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
// ── Settings I/O for hooks visibility ────────────────────────────────────────
const TALON_SETTINGS_PATH = join(homedir(), ".talon", "settings.json");
export async function loadTalonSettings() {
    try {
        const raw = await readFile(TALON_SETTINGS_PATH, "utf-8");
        return JSON.parse(raw);
    }
    catch {
        return {};
    }
}
export async function saveTalonSettings(settings) {
    await mkdir(join(homedir(), ".talon"), { recursive: true });
    let existing = {};
    try {
        existing = JSON.parse(await readFile(TALON_SETTINGS_PATH, "utf-8"));
    }
    catch { }
    const merged = { ...existing, ...settings };
    await writeFile(TALON_SETTINGS_PATH, JSON.stringify(merged, null, 2));
}
/** Check if hooks should be displayed (default: true). */
export async function areHooksVisible() {
    const settings = await loadTalonSettings();
    return settings.hooksVisible !== false;
}
/** Set hooks visibility. */
export async function setHooksVisible(visible) {
    await saveTalonSettings({ hooksVisible: visible });
}
// ── Command Registry ─────────────────────────────────────────────────────────
const registry = new Map();
/** Register a command. Overwrites existing commands with the same name. */
export function registerCommand(def) {
    registry.set(def.name.toLowerCase(), def);
}
/** Unregister a command. */
export function unregisterCommand(name) {
    return registry.delete(name.toLowerCase());
}
/** Get a registered command by name. */
export function getCommand(name) {
    return registry.get(name.toLowerCase());
}
/** List all registered commands. */
export function listCommands() {
    return [...registry.values()];
}
/** Parse a command string (e.g. "/hooks on") → { name, arg }. */
export function parseHubCommand(text) {
    const trimmed = text.trim();
    if (!trimmed.startsWith("/"))
        return null;
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
export async function executeCommand(hub, text, context = {}) {
    const parsed = parseHubCommand(text);
    if (!parsed)
        return null;
    const def = registry.get(parsed.name);
    if (!def)
        return null;
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
        const lines = agents.map((a) => `• ${a.name} (tools: ${a.tools.join(", ") || "none"})`);
        return { text: `Connected agents:\n${lines.join("\n")}` };
    },
});
registerCommand({
    name: "targets",
    description: "List addressable targets with UUIDs",
    handler: async (hub) => {
        const registry = hub.targetRegistry;
        if (!registry || !registry.size) {
            return { text: "No targets registered." };
        }
        const lines = [...registry.entries()].map(([uuid, entry]) => `• ${entry.name} (${entry.kind}) uuid:${uuid}`);
        return { text: `Targets:\n${lines.join("\n")}` };
    },
});
registerCommand({
    name: "approve",
    description: "Approve a pending agent: /approve <code>",
    handler: async (hub, arg) => {
        const code = arg?.trim();
        if (!code) {
            const pending = [...hub.pendingAgents.entries()]
                .map(([code, p]) => `• ${code} — ${p.name} from ${p.address}`);
            if (!pending.length)
                return { text: "No pending agents." };
            return { text: `Pending approvals:\n${pending.join("\n")}` };
        }
        const result = await hub.approveAgent(code);
        if (result.ok) {
            return { text: `Approved "${result.name}".` };
        }
        return { text: `Approval failed: ${result.error}` };
    },
});
// ── Install onto ChannelHub ──────────────────────────────────────────────────
export function installCommands(Hub) {
    /** Register a custom command on this hub. */
    Hub.prototype.registerCommand = function (def) {
        registerCommand(def);
    };
    /** Execute a slash command string. Returns null if not recognized. */
    Hub.prototype.executeCommand = function (text, context) {
        return executeCommand(this, text, context);
    };
    /** List all registered commands. */
    Hub.prototype.listCommands = function () {
        return listCommands();
    };
}
//# sourceMappingURL=hub-commands.js.map