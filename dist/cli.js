#!/usr/bin/env node
/**
 * Talon CLI — Universal channel bridge for any CLI tool.
 *
 * Wraps CLI tools (codex, claude, gemini, etc.) with full channel support:
 * Telegram, WebSocket, agent-to-agent — without the tool needing to know.
 *
 * Architecture:
 *   ┌──────────┐      stdin       ┌──────────────┐     channels     ┌──────────┐
 *   │  child    │ ◄──────────────► │  ChannelHub  │ ◄──────────────► │ Telegram │
 *   │ (codex,   │   stdout        │  (in-proc)   │                  │ WS, etc. │
 *   │  claude…) │                 └──────────────┘                  └──────────┘
 *   └──────────┘
 *
 * Usage:
 *   talon codex [prompt]         — Run OpenAI Codex CLI with channels
 *   talon claude [prompt]        — Run Claude Code CLI with channels
 *   talon gemini [prompt]        — Run Gemini CLI with channels
 *   talon <any-cli> [args...]    — Run any CLI tool with channels
 *
 * Environment:
 *   TALON_PORT       — Hub server port (default: 9090)
 *   TALON_NO_SERVER  — Skip starting the hub server (connect-only mode)
 *   TALON_AGENT_NAME — Name for this agent in the hub
 */
import { spawn } from "node:child_process";
import { ChannelHub } from "./hub.js";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
const BACKENDS = {
    codex: {
        command: "codex",
        defaultArgs: [],
        promptArg: (p) => [p],
        interactive: true,
    },
    claude: {
        command: "claude",
        defaultArgs: ["--dangerously-skip-permissions", "--dangerously-load-development-channels", "plugin:talon-hub@gettalon/talon-plugins"],
        promptArg: (p) => ["--dangerously-skip-permissions", "--dangerously-load-development-channels", "plugin:talon-hub@gettalon/talon-plugins", "-p", p],
        interactive: true,
    },
    gemini: {
        command: "gemini",
        defaultArgs: [],
        promptArg: (p) => [p],
        interactive: true,
    },
};
// ── Arg Parsing ─────────────────────────────────────────────────────────────
function parseArgs(argv) {
    // argv[0] = node, argv[1] = cli.js, argv[2] = backend, argv[3..] = rest
    const rawArgs = argv.slice(2);
    if (rawArgs.length === 0 || rawArgs[0] === "--help" || rawArgs[0] === "-h") {
        printUsage();
        process.exit(0);
    }
    const backend = rawArgs[0];
    const rest = rawArgs.slice(1);
    // If the rest looks like a prompt (not starting with --), treat it as one
    const prompt = rest.length > 0 && !rest[0].startsWith("--") ? rest.join(" ") : null;
    const args = prompt ? [] : rest;
    return { backend, args, prompt };
}
function printUsage() {
    const msg = `
Talon CLI — Universal channel bridge for CLI tools

Usage:
  talon <backend> [prompt or args...]

Backends:
  codex    OpenAI Codex CLI
  claude   Claude Code CLI
  gemini   Gemini CLI
  <any>    Any CLI command (e.g. "talon python script.py")

Examples:
  talon codex "fix the login bug"
  talon claude "refactor auth module"
  talon gemini "write unit tests"
  talon my-tool --flag value

Environment:
  TALON_PORT         Hub server port (default: 9090)
  TALON_NO_SERVER    Skip starting hub server
  TALON_AGENT_NAME   Agent name in the hub network
`;
    process.stderr.write(msg.trim() + "\n");
}
// ── Line Buffering ──────────────────────────────────────────────────────────
/**
 * Buffer output from the child and emit complete lines.
 * Handles partial lines that arrive across chunk boundaries.
 */
class LineBuffer {
    partial = "";
    onLine;
    constructor(onLine) {
        this.onLine = onLine;
    }
    push(chunk) {
        this.partial += chunk;
        const lines = this.partial.split("\n");
        // Keep the last (potentially partial) piece
        this.partial = lines.pop() ?? "";
        for (const line of lines) {
            this.onLine(line);
        }
    }
    flush() {
        if (this.partial) {
            this.onLine(this.partial);
            this.partial = "";
        }
    }
}
function compareVersionsDesc(a, b) {
    const aParts = a.split(".").map((part) => parseInt(part, 10) || 0);
    const bParts = b.split(".").map((part) => parseInt(part, 10) || 0);
    const maxLen = Math.max(aParts.length, bParts.length);
    for (let i = 0; i < maxLen; i += 1) {
        const diff = (bParts[i] ?? 0) - (aParts[i] ?? 0);
        if (diff !== 0)
            return diff;
    }
    return 0;
}
function resolveCachedPluginServerPath() {
    const cacheRoots = [
        join(homedir(), ".claude", "plugins", "cache", "gettalon", "talon-plugins", "talon-hub"),
    ];
    for (const root of cacheRoots) {
        if (!existsSync(root))
            continue;
        const versions = readdirSync(root, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name)
            .sort(compareVersionsDesc);
        for (const version of versions) {
            const candidate = join(root, version, "mcp-server", "server.js");
            if (existsSync(candidate))
                return candidate;
        }
    }
    return null;
}
// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
    const { backend, args, prompt } = parseArgs(process.argv);
    // Resolve backend definition (known backends get smart defaults, unknown get passthrough)
    const def = BACKENDS[backend] ?? {
        command: backend,
        defaultArgs: [],
        promptArg: (p) => [p],
        interactive: true,
    };
    // Translate --yolo to per-backend flag
    const yoloFlags = {
        claude: "--dangerously-skip-permissions",
        codex: "--full-auto",
    };
    const translatedArgs = args.map(a => a === "--yolo" ? (yoloFlags[backend] ?? a) : a);
    // Build child args — user args append to defaults
    let childArgs;
    if (prompt) {
        childArgs = [...def.promptArg(prompt), ...translatedArgs];
    }
    else if (translatedArgs.length > 0) {
        childArgs = [...def.defaultArgs, ...translatedArgs];
    }
    else {
        childArgs = def.defaultArgs;
    }
    // ── Start ChannelHub ────────────────────────────────────────────────────
    const port = parseInt(process.env.TALON_PORT ?? "9090", 10);
    const agentName = process.env.TALON_AGENT_NAME ?? `talon-${backend}`;
    const hub = new ChannelHub({
        name: agentName,
        port,
        autoStart: process.env.TALON_NO_SERVER !== "1",
        autoConnect: true,
        agentName,
    });
    await hub.autoSetup();
    process.stderr.write(`[talon] Hub ready (${hub.serverRunning() ? `server :${port}` : "client"}, agents: ${hub.agents.size})\n`);
    // ── Auto-inject MCP config for talon ────────────────────────────────────
    const selfDir = new URL(".", import.meta.url).pathname;
    const localServerJs = join(selfDir, "architect.js");
    const cachedServerJs = resolveCachedPluginServerPath();
    const mcpServerPath = cachedServerJs ?? localServerJs;
    const mcpConfigPath = join(tmpdir(), `talon-${backend}-mcp.json`);
    writeFileSync(mcpConfigPath, JSON.stringify({
        mcpServers: {
            "talon-hub": {
                command: "node",
                args: [mcpServerPath]
            }
        }
    }));
    // Inject --mcp-config for backends that support it
    if (backend === "codex" && !childArgs.includes("--mcp-config")) {
        childArgs = ["--mcp-config", mcpConfigPath, ...childArgs];
    }
    else if (backend === "claude" && !childArgs.includes("--mcp-config")) {
        childArgs = ["--mcp-config", mcpConfigPath, ...childArgs];
    }
    // ── Spawn Child Process ─────────────────────────────────────────────────
    process.stderr.write(`[talon] Spawning: ${def.command} ${childArgs.join(" ")}\n`);
    process.stderr.write(`[talon] MCP config: ${mcpConfigPath}\n`);
    // Inherit stdin/stdout/stderr for full TTY passthrough (interactive mode)
    // Communication happens via ChannelHub (WS side channel), not stdio pipes
    const child = spawn(def.command, childArgs, {
        stdio: ["inherit", "inherit", "inherit"],
        env: { ...process.env },
        cwd: process.cwd(),
    });
    // Track which channel+chatId originated each conversation so replies route back
    const activeChatId = { value: null };
    // ── Bridge: Hub messages → reply via WS (no stdin piping) ──────────────
    // The child runs interactively with full TTY. Channel messages are handled
    // by the ChannelHub side channel — not piped into the child's stdin.
    // Messages from channels are logged and can be replied to via hub tools.
    hub.on("message", ({ content, chatId, user, type }) => {
        if (type !== "chat")
            return;
        process.stderr.write(`[talon] Channel message from ${user} (${chatId}): ${content.slice(0, 80)}${content.length > 80 ? "..." : ""}\n`);
        activeChatId.value = chatId;
    });
    // ── Handle Child Exit ─────────────────────────────────────────────────
    child.on("exit", (code, signal) => {
        const reason = signal ? `signal ${signal}` : `code ${code ?? 0}`;
        process.stderr.write(`[talon] ${def.command} exited (${reason})\n`);
        // Notify connected channels
        if (activeChatId.value) {
            hub.reply(activeChatId.value, `[${def.command} exited: ${reason}]`);
        }
        // Broadcast exit to all agents
        for (const agent of hub.agents.values()) {
            hub.wsSend(agent.ws, {
                type: "chat",
                chat_id: agent.id,
                content: `[${def.command} exited: ${reason}]`,
                from: agentName,
            });
        }
        // Clean shutdown
        cleanup(code ?? 0);
    });
    child.on("error", (err) => {
        process.stderr.write(`[talon] Failed to spawn ${def.command}: ${err.message}\n`);
        process.stderr.write(`[talon] Make sure "${def.command}" is installed and in your PATH\n`);
        cleanup(1);
    });
    // ── Graceful Shutdown ─────────────────────────────────────────────────
    let exiting = false;
    function cleanup(exitCode) {
        if (exiting)
            return;
        exiting = true;
        // Stop hub servers
        for (const [id, server] of hub.servers) {
            try {
                server.wss?.close();
                server.httpServer?.close();
            }
            catch { }
        }
        // Close client connections
        for (const [, client] of hub.clients) {
            try {
                client.ws.close();
            }
            catch { }
        }
        // Kill child if still running
        if (child && !child.killed) {
            try {
                child.stdin?.end();
                child.kill("SIGTERM");
            }
            catch { }
        }
        process.exit(exitCode);
    }
    process.on("SIGTERM", () => {
        process.stderr.write("[talon] SIGTERM received, shutting down...\n");
        if (child && !child.killed) {
            child.kill("SIGTERM");
        }
        // The child exit handler will call cleanup
        setTimeout(() => cleanup(0), 2000);
    });
    process.on("SIGINT", () => {
        process.stderr.write("\n[talon] SIGINT received, shutting down...\n");
        if (child && !child.killed) {
            child.kill("SIGINT");
        }
        setTimeout(() => cleanup(0), 2000);
    });
}
// ── Run ─────────────────────────────────────────────────────────────────────
main().catch((err) => {
    process.stderr.write(`[talon] Fatal: ${err}\n`);
    process.exit(1);
});
//# sourceMappingURL=cli.js.map