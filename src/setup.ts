#!/usr/bin/env node
/**
 * Claude Channels SDK — Setup Script
 *
 * Interactive setup that configures Claude Code settings:
 * - Adds your channel as an MCP server
 * - Installs hook commands for selected events (with full path resolution)
 * - Configures channel type and credentials (env vars in settings.json)
 * - Auto-detects claude-hook binary path
 *
 * Usage:
 *   npx @gettalon/channels-sdk setup
 *   npx @gettalon/channels-sdk setup --name my-channel --entry ./my-server.js
 *   npx @gettalon/channels-sdk setup --channel telegram --token YOUR_BOT_TOKEN
 *   npx @gettalon/channels-sdk setup --preset all
 *   npx @gettalon/channels-sdk setup --hooks PreToolUse,PostToolUse,Notification
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { BLOCKING_EVENTS } from "./types.js";
import type { HookEventName } from "./types.js";

// ─── Constants ───────────────────────────────────────────────────────────────

const CLAUDE_DIR = join(homedir(), ".claude");
const SETTINGS_PATH = join(CLAUDE_DIR, "settings.json");
const DEFAULT_SOCKET = join(CLAUDE_DIR, "channel-hooks.sock");

const ALL_HOOKS: HookEventName[] = [
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

const HOOK_PRESETS: Record<string, HookEventName[]> = {
  minimal: ["PreToolUse", "PostToolUse", "Notification"],
  chat: ["UserPromptSubmit", "Notification", "Stop"],
  monitor: [
    "SessionStart", "SessionEnd",
    "PreToolUse", "PostToolUse", "PostToolUseFailure",
    "Notification",
    "SubagentStart", "SubagentStop",
    "Stop",
  ],
  permissions: ["PreToolUse", "PermissionRequest", "Notification"],
  all: ALL_HOOKS,
};

const SUPPORTED_CHANNELS = [
  "websocket", "telegram", "discord", "slack", "whatsapp", "signal",
  "imessage", "irc", "googlechat", "line", "feishu", "matrix",
  "mattermost", "msteams", "bluebubbles", "nostr", "nextcloud-talk",
  "synology-chat", "tlon", "twitch", "zalo", "zalouser",
];

const CHANNEL_ENV_VARS: Record<string, string[]> = {
  telegram: ["TELEGRAM_BOT_TOKEN"],
  discord: ["DISCORD_BOT_TOKEN"],
  slack: ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"],
  whatsapp: ["WHATSAPP_API_TOKEN", "WHATSAPP_PHONE_NUMBER_ID"],
  signal: ["SIGNAL_CLI_PATH", "SIGNAL_PHONE_NUMBER"],
  irc: ["IRC_SERVER", "IRC_NICK", "IRC_CHANNEL"],
  googlechat: ["GOOGLE_CHAT_CREDENTIALS", "GOOGLE_CHAT_SPACE"],
  line: ["LINE_CHANNEL_ACCESS_TOKEN", "LINE_CHANNEL_SECRET"],
  feishu: ["FEISHU_APP_ID", "FEISHU_APP_SECRET"],
  matrix: ["MATRIX_HOMESERVER", "MATRIX_ACCESS_TOKEN"],
  mattermost: ["MATTERMOST_URL", "MATTERMOST_TOKEN"],
  msteams: ["MSTEAMS_APP_ID", "MSTEAMS_APP_PASSWORD"],
  nostr: ["NOSTR_PRIVATE_KEY"],
  twitch: ["TWITCH_OAUTH_TOKEN", "TWITCH_CHANNEL"],
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

const rl = createInterface({ input: process.stdin, output: process.stderr });

function ask(question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

function loadSettings(): Record<string, any> {
  mkdirSync(CLAUDE_DIR, { recursive: true });
  if (existsSync(SETTINGS_PATH)) {
    try {
      return JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
    } catch {
      return {};
    }
  }
  return {};
}

function saveSettings(settings: Record<string, any>): void {
  writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n");
}

function bold(s: string): string { return `\x1b[1m${s}\x1b[0m`; }
function green(s: string): string { return `\x1b[32m${s}\x1b[0m`; }
function cyan(s: string): string { return `\x1b[36m${s}\x1b[0m`; }
function dim(s: string): string { return `\x1b[2m${s}\x1b[0m`; }
function yellow(s: string): string { return `\x1b[33m${s}\x1b[0m`; }
function red(s: string): string { return `\x1b[31m${s}\x1b[0m`; }

/**
 * Resolve the full path to claude-hook binary.
 * Tries: 1) sibling in same package, 2) which, 3) npx cache, 4) global node_modules
 */
function resolveHookPath(): string {
  // 1. Sibling in same package (most reliable)
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const siblingPath = join(__dirname, "hook-script.js");
  if (existsSync(siblingPath)) {
    return `node ${siblingPath}`;
  }

  // 2. which claude-hook
  try {
    const whichResult = execSync("which claude-hook 2>/dev/null", { encoding: "utf-8" }).trim();
    if (whichResult) return whichResult;
  } catch {}

  // 3. npx cache
  try {
    const npxDirs = execSync("ls -d ~/.npm/_npx/*/node_modules/.bin/claude-hook 2>/dev/null", { encoding: "utf-8" }).trim();
    if (npxDirs) {
      const first = npxDirs.split("\n")[0];
      if (existsSync(first)) return first;
    }
  } catch {}

  // 4. Fallback: use npx to run it (slower but always works)
  return "npx -y -p @gettalon/channels-sdk claude-hook";
}

// ─── Parse CLI args ──────────────────────────────────────────────────────────

interface SetupArgs {
  name?: string;
  entry?: string;
  socket?: string;
  hooks?: string;
  allHooks?: boolean;
  preset?: string;
  channel?: string;
  token?: string;
  nonInteractive?: boolean;
}

function parseArgs(): SetupArgs {
  const args = process.argv.slice(2);
  const result: SetupArgs = {};

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--name": result.name = args[++i]; break;
      case "--entry": result.entry = args[++i]; break;
      case "--socket": result.socket = args[++i]; break;
      case "--hooks": result.hooks = args[++i]; break;
      case "--all-hooks": result.allHooks = true; break;
      case "--preset": result.preset = args[++i]; break;
      case "--channel": result.channel = args[++i]; break;
      case "--token": result.token = args[++i]; break;
      case "--yes": case "-y": result.nonInteractive = true; break;
    }
  }

  return result;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs();

  process.stderr.write("\n");
  process.stderr.write(bold("  Claude Channels SDK — Setup\n"));
  process.stderr.write(dim("  Configure Claude Code to use your channel\n"));
  process.stderr.write("\n");

  // ─── Step 1: Channel type ──────────────────────────────────────────

  let channel = args.channel;
  if (!channel) {
    process.stderr.write(bold("  Channel Types:\n"));
    process.stderr.write(`  ${cyan("1")} websocket  — Default, local WebSocket server\n`);
    process.stderr.write(`  ${cyan("2")} telegram   — Telegram Bot API\n`);
    process.stderr.write(`  ${cyan("3")} discord    — Discord bot\n`);
    process.stderr.write(`  ${cyan("4")} slack      — Slack Bot (Socket Mode)\n`);
    process.stderr.write(`  ${cyan("5")} other      — Enter channel name\n`);
    process.stderr.write("\n");

    const choice = await ask(cyan("? ") + "Select channel " + dim("[1-5]") + ": ");
    switch (choice) {
      case "1": channel = "websocket"; break;
      case "2": channel = "telegram"; break;
      case "3": channel = "discord"; break;
      case "4": channel = "slack"; break;
      case "5":
        channel = await ask(cyan("? ") + "Channel name: ");
        break;
      default:
        channel = "websocket";
        process.stderr.write(dim("  Using default: websocket\n"));
    }
  }

  if (!SUPPORTED_CHANNELS.includes(channel!)) {
    process.stderr.write(red(`  Unknown channel: ${channel}\n`));
    process.stderr.write(dim(`  Supported: ${SUPPORTED_CHANNELS.join(", ")}\n`));
    rl.close();
    process.exit(1);
  }

  // ─── Step 2: Channel credentials ──────────────────────────────────

  const envVars: Record<string, string> = {};
  if (channel !== "websocket") {
    envVars.TALON_CHANNEL = channel!;

    const requiredEnvs = CHANNEL_ENV_VARS[channel!] ?? [];

    if (args.token && requiredEnvs.length > 0) {
      // --token shortcut: assign to the first required env var
      envVars[requiredEnvs[0]] = args.token;
    } else {
      for (const envVar of requiredEnvs) {
        // Check if already set in environment
        const existing = process.env[envVar];
        if (existing) {
          envVars[envVar] = existing;
          process.stderr.write(green("  ✓ ") + `${envVar} found in environment\n`);
        } else {
          const value = await ask(cyan("? ") + `${envVar}: `);
          if (value) {
            envVars[envVar] = value;
          } else {
            process.stderr.write(yellow(`  ⚠ ${envVar} not set — you'll need to add it later\n`));
          }
        }
      }
    }
  }

  // ─── Step 3: Channel name ─────────────────────────────────────────

  let name = args.name ?? "talon-channels";

  // ─── Step 4: Hook selection ────────────────────────────────────────

  let selectedHooks: HookEventName[];

  if (args.allHooks) {
    selectedHooks = ALL_HOOKS;
  } else if (args.hooks) {
    selectedHooks = args.hooks.split(",").map(h => h.trim()) as HookEventName[];
  } else if (args.preset && HOOK_PRESETS[args.preset]) {
    selectedHooks = HOOK_PRESETS[args.preset];
  } else {
    process.stderr.write("\n");
    process.stderr.write(bold("  Hook Presets:\n"));
    process.stderr.write(`  ${cyan("1")} minimal    — PreToolUse, PostToolUse, Notification\n`);
    process.stderr.write(`  ${cyan("2")} chat       — UserPromptSubmit, Notification, Stop\n`);
    process.stderr.write(`  ${cyan("3")} monitor    — Session, tools, agents, notifications\n`);
    process.stderr.write(`  ${cyan("4")} permissions — PreToolUse, PermissionRequest, Notification\n`);
    process.stderr.write(`  ${cyan("5")} all        — All 23 hook events\n`);
    process.stderr.write(`  ${cyan("6")} none       — Skip hooks (add manually later)\n`);
    process.stderr.write("\n");

    const choice = await ask(cyan("? ") + "Select preset " + dim("[1-6]") + ": ");

    switch (choice) {
      case "1": selectedHooks = HOOK_PRESETS.minimal; break;
      case "2": selectedHooks = HOOK_PRESETS.chat; break;
      case "3": selectedHooks = HOOK_PRESETS.monitor; break;
      case "4": selectedHooks = HOOK_PRESETS.permissions; break;
      case "5": selectedHooks = HOOK_PRESETS.all; break;
      case "6": selectedHooks = []; break;
      default:
        selectedHooks = HOOK_PRESETS.minimal;
        process.stderr.write(dim("  Using default: minimal\n"));
    }
  }

  // ─── Step 5: Resolve hook binary path ──────────────────────────────

  const hookCommand = resolveHookPath();
  const socket = args.socket ?? DEFAULT_SOCKET;

  process.stderr.write("\n");
  process.stderr.write(dim(`  Hook binary: ${hookCommand}\n`));

  // ─── Step 6: Apply settings ───────────────────────────────────────

  const settings = loadSettings();

  // Add env vars to settings.json env field
  if (Object.keys(envVars).length > 0) {
    if (!settings.env) settings.env = {};
    for (const [key, value] of Object.entries(envVars)) {
      settings.env[key] = value;
    }
    process.stderr.write(green("  ✓ ") + `Set ${bold(String(Object.keys(envVars).length))} env vars in settings.json\n`);
  }

  // Add hooks
  if (selectedHooks.length > 0) {
    if (!settings.hooks) settings.hooks = {};

    for (const event of selectedHooks) {
      const isBlocking = BLOCKING_EVENTS.has(event);
      const hookEntry = {
        hooks: [
          {
            type: "command",
            command: `${hookCommand} --socket ${socket}`,
            timeout: isBlocking ? 60 : 10,
          },
        ],
      };

      // Merge with existing hooks for this event
      if (Array.isArray(settings.hooks[event])) {
        const existing = settings.hooks[event].find(
          (h: any) => h.hooks?.some((hh: any) => hh.command?.includes("claude-hook") || hh.command?.includes("hook-script"))
        );
        if (!existing) {
          settings.hooks[event].push(hookEntry);
        } else {
          // Update existing entry with new path
          const idx = settings.hooks[event].indexOf(existing);
          settings.hooks[event][idx] = hookEntry;
        }
      } else {
        settings.hooks[event] = [hookEntry];
      }
    }

    process.stderr.write(green("  ✓ ") + `Installed ${bold(String(selectedHooks.length))} hook events\n`);

    const blockingCount = selectedHooks.filter(h => BLOCKING_EVENTS.has(h)).length;
    if (blockingCount > 0) {
      process.stderr.write(dim(`    ${blockingCount} blocking, ${selectedHooks.length - blockingCount} non-blocking\n`));
    }
  }

  // Save
  saveSettings(settings);
  process.stderr.write(green("  ✓ ") + `Saved ${dim(SETTINGS_PATH)}\n`);

  // ─── Summary ──────────────────────────────────────────────────────

  process.stderr.write("\n");
  process.stderr.write(bold("  Done!\n"));
  process.stderr.write("\n");

  if (channel !== "websocket") {
    process.stderr.write(`  Channel: ${bold(channel!)}\n`);
    process.stderr.write(`  Env vars stored in: ${dim(SETTINGS_PATH)} (survives plugin reloads)\n`);
  }

  if (selectedHooks.length > 0) {
    process.stderr.write(`  Hook socket: ${dim(socket)}\n`);
  }

  process.stderr.write("\n");
  process.stderr.write(dim("  Restart Claude Code to apply changes.\n"));
  process.stderr.write(dim("  To reconfigure: npx @gettalon/channels-sdk setup\n"));
  process.stderr.write(dim("  To remove: npx @gettalon/channels-sdk remove\n"));
  process.stderr.write("\n");

  rl.close();
}

// ─── Remove command ──────────────────────────────────────────────────────────

async function remove(): Promise<void> {
  process.stderr.write("\n");
  process.stderr.write(bold("  Claude Channels SDK — Remove\n"));
  process.stderr.write("\n");

  const settings = loadSettings();
  let changed = false;

  // Remove hooks containing claude-hook or hook-script
  if (settings.hooks) {
    for (const event of Object.keys(settings.hooks)) {
      if (Array.isArray(settings.hooks[event])) {
        settings.hooks[event] = settings.hooks[event].filter(
          (h: any) => !h.hooks?.some((hh: any) =>
            hh.command?.includes("claude-hook") || hh.command?.includes("hook-script")
          )
        );
        if (settings.hooks[event].length === 0) {
          delete settings.hooks[event];
        }
      }
    }
    if (Object.keys(settings.hooks).length === 0) {
      delete settings.hooks;
    }
    changed = true;
    process.stderr.write(green("  ✓ ") + "Removed hook entries\n");
  }

  // Remove channel env vars
  if (settings.env) {
    const channelVars = ["TALON_CHANNEL", ...Object.values(CHANNEL_ENV_VARS).flat()];
    for (const key of channelVars) {
      if (settings.env[key]) {
        delete settings.env[key];
        changed = true;
      }
    }
    process.stderr.write(green("  ✓ ") + "Removed channel env vars\n");
  }

  // Remove MCP servers
  if (settings.mcpServers) {
    const channels = Object.entries(settings.mcpServers).filter(
      ([name, _]: [string, any]) => name.includes("channel") || name.includes("talon")
    );
    if (channels.length > 0) {
      for (const [name] of channels) {
        delete settings.mcpServers[name];
        process.stderr.write(green("  ✓ ") + `Removed MCP server ${bold(name)}\n`);
      }
      if (Object.keys(settings.mcpServers).length === 0) {
        delete settings.mcpServers;
      }
      changed = true;
    }
  }

  if (changed) {
    saveSettings(settings);
    process.stderr.write(green("  ✓ ") + `Saved ${dim(SETTINGS_PATH)}\n`);
  } else {
    process.stderr.write(dim("  Nothing to remove\n"));
  }

  process.stderr.write("\n");
  rl.close();
}

// ─── Entry ───────────────────────────────────────────────────────────────────

const command = process.argv[2];
if (command === "remove" || command === "uninstall") {
  remove().catch((err) => {
    process.stderr.write(`Error: ${err}\n`);
    process.exit(1);
  });
} else {
  main().catch((err) => {
    process.stderr.write(`Error: ${err}\n`);
    process.exit(1);
  });
}
