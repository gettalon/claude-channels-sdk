#!/usr/bin/env node
/**
 * Claude Channels SDK — Setup Script
 *
 * Interactive setup that configures Claude Code settings:
 * - Adds your channel as an MCP server
 * - Installs hook commands for selected events
 *
 * Usage:
 *   npx @gettalon/channels-sdk setup
 *   npx @gettalon/channels-sdk setup --name my-channel --entry ./my-server.js
 *   npx @gettalon/channels-sdk setup --all-hooks
 *   npx @gettalon/channels-sdk setup --hooks PreToolUse,PostToolUse,Notification
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import { BLOCKING_EVENTS } from "./types.js";
// ─── Constants ───────────────────────────────────────────────────────────────
const CLAUDE_DIR = join(homedir(), ".claude");
const SETTINGS_PATH = join(CLAUDE_DIR, "settings.json");
const DEFAULT_SOCKET = join(CLAUDE_DIR, "channel-hooks.sock");
const ALL_HOOKS = [
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
const HOOK_PRESETS = {
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
// ─── Helpers ─────────────────────────────────────────────────────────────────
const rl = createInterface({ input: process.stdin, output: process.stderr });
function ask(question) {
    return new Promise((resolve) => {
        rl.question(question, (answer) => resolve(answer.trim()));
    });
}
function loadSettings() {
    mkdirSync(CLAUDE_DIR, { recursive: true });
    if (existsSync(SETTINGS_PATH)) {
        try {
            return JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
        }
        catch {
            return {};
        }
    }
    return {};
}
function saveSettings(settings) {
    writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n");
}
function bold(s) { return `\x1b[1m${s}\x1b[0m`; }
function green(s) { return `\x1b[32m${s}\x1b[0m`; }
function cyan(s) { return `\x1b[36m${s}\x1b[0m`; }
function dim(s) { return `\x1b[2m${s}\x1b[0m`; }
function yellow(s) { return `\x1b[33m${s}\x1b[0m`; }
function parseArgs() {
    const args = process.argv.slice(2);
    const result = {};
    for (let i = 0; i < args.length; i++) {
        switch (args[i]) {
            case "--name":
                result.name = args[++i];
                break;
            case "--entry":
                result.entry = args[++i];
                break;
            case "--socket":
                result.socket = args[++i];
                break;
            case "--hooks":
                result.hooks = args[++i];
                break;
            case "--all-hooks":
                result.allHooks = true;
                break;
            case "--preset":
                result.preset = args[++i];
                break;
            case "--yes":
            case "-y":
                result.nonInteractive = true;
                break;
        }
    }
    return result;
}
// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
    const args = parseArgs();
    process.stderr.write("\n");
    process.stderr.write(bold("  Claude Channels SDK — Setup\n"));
    process.stderr.write(dim("  Configure Claude Code to use your channel\n"));
    process.stderr.write("\n");
    // ─── Step 1: Channel name ────────────────────────────────────────────
    let name = args.name;
    if (!name) {
        name = await ask(cyan("? ") + "Channel name: ");
        if (!name) {
            name = "my-channel";
            process.stderr.write(dim(`  Using default: ${name}\n`));
        }
    }
    // ─── Step 2: Server entry point ──────────────────────────────────────
    let entry = args.entry;
    if (!entry) {
        entry = await ask(cyan("? ") + "Server entry point " + dim("(e.g. ./my-server.js)") + ": ");
        if (!entry) {
            process.stderr.write(yellow("  Skipping MCP server config — add it manually later\n"));
        }
    }
    // ─── Step 3: Socket path ─────────────────────────────────────────────
    const socket = args.socket ?? DEFAULT_SOCKET;
    // ─── Step 4: Hook selection ──────────────────────────────────────────
    let selectedHooks;
    if (args.allHooks) {
        selectedHooks = ALL_HOOKS;
    }
    else if (args.hooks) {
        selectedHooks = args.hooks.split(",").map(h => h.trim());
    }
    else if (args.preset && HOOK_PRESETS[args.preset]) {
        selectedHooks = HOOK_PRESETS[args.preset];
    }
    else {
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
            case "1":
                selectedHooks = HOOK_PRESETS.minimal;
                break;
            case "2":
                selectedHooks = HOOK_PRESETS.chat;
                break;
            case "3":
                selectedHooks = HOOK_PRESETS.monitor;
                break;
            case "4":
                selectedHooks = HOOK_PRESETS.permissions;
                break;
            case "5":
                selectedHooks = HOOK_PRESETS.all;
                break;
            case "6":
                selectedHooks = [];
                break;
            default:
                selectedHooks = HOOK_PRESETS.minimal;
                process.stderr.write(dim("  Using default: minimal\n"));
        }
    }
    // ─── Step 5: Apply settings ──────────────────────────────────────────
    process.stderr.write("\n");
    const settings = loadSettings();
    // Add MCP server
    if (entry) {
        if (!settings.mcpServers)
            settings.mcpServers = {};
        settings.mcpServers[name] = {
            command: "node",
            args: [entry],
        };
        process.stderr.write(green("  ✓ ") + `Added MCP server ${bold(name)}\n`);
    }
    // Add hooks
    if (selectedHooks.length > 0) {
        if (!settings.hooks)
            settings.hooks = {};
        for (const event of selectedHooks) {
            const isBlocking = BLOCKING_EVENTS.has(event);
            const hookEntry = {
                hooks: [
                    {
                        type: "command",
                        command: `claude-hook --socket ${socket}`,
                        timeout: isBlocking ? 60 : 10,
                    },
                ],
            };
            // Merge with existing hooks for this event
            if (Array.isArray(settings.hooks[event])) {
                // Check if we already have a claude-hook entry
                const existing = settings.hooks[event].find((h) => h.hooks?.some((hh) => hh.command?.includes("claude-hook")));
                if (!existing) {
                    settings.hooks[event].push(hookEntry);
                }
            }
            else {
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
    // ─── Summary ─────────────────────────────────────────────────────────
    process.stderr.write("\n");
    process.stderr.write(bold("  Done!\n"));
    process.stderr.write("\n");
    if (entry) {
        process.stderr.write(dim("  Your channel server will start automatically when Claude Code\n"));
        process.stderr.write(dim("  connects. Make sure your server file exports a running ChannelServer.\n"));
    }
    if (selectedHooks.length > 0) {
        process.stderr.write("\n");
        process.stderr.write(dim("  Hook events will be forwarded to your channel via:\n"));
        process.stderr.write(dim(`    ${socket}\n`));
    }
    process.stderr.write("\n");
    process.stderr.write(dim("  To reconfigure: npx @gettalon/channels-sdk setup\n"));
    process.stderr.write(dim("  To remove: npx @gettalon/channels-sdk remove\n"));
    process.stderr.write("\n");
    rl.close();
}
// ─── Remove command ──────────────────────────────────────────────────────────
async function remove() {
    process.stderr.write("\n");
    process.stderr.write(bold("  Claude Channels SDK — Remove\n"));
    process.stderr.write("\n");
    const settings = loadSettings();
    let changed = false;
    // Remove hooks containing claude-hook
    if (settings.hooks) {
        for (const event of Object.keys(settings.hooks)) {
            if (Array.isArray(settings.hooks[event])) {
                settings.hooks[event] = settings.hooks[event].filter((h) => !h.hooks?.some((hh) => hh.command?.includes("claude-hook")));
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
    // Ask which MCP server to remove
    if (settings.mcpServers) {
        const channels = Object.entries(settings.mcpServers).filter(([_, v]) => v.command === "node");
        if (channels.length > 0) {
            process.stderr.write("\n  MCP servers found:\n");
            channels.forEach(([name], i) => {
                process.stderr.write(`  ${cyan(String(i + 1))} ${name}\n`);
            });
            const choice = await ask(cyan("\n? ") + "Remove which server? " + dim("(number or name, empty to skip)") + ": ");
            if (choice) {
                const idx = parseInt(choice) - 1;
                const nameToRemove = idx >= 0 && idx < channels.length ? channels[idx][0] : choice;
                if (settings.mcpServers[nameToRemove]) {
                    delete settings.mcpServers[nameToRemove];
                    if (Object.keys(settings.mcpServers).length === 0) {
                        delete settings.mcpServers;
                    }
                    changed = true;
                    process.stderr.write(green("  ✓ ") + `Removed MCP server ${bold(nameToRemove)}\n`);
                }
            }
        }
    }
    if (changed) {
        saveSettings(settings);
        process.stderr.write(green("  ✓ ") + `Saved ${dim(SETTINGS_PATH)}\n`);
    }
    else {
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
}
else {
    main().catch((err) => {
        process.stderr.write(`Error: ${err}\n`);
        process.exit(1);
    });
}
//# sourceMappingURL=setup.js.map