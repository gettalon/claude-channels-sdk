/**
 * Daemon mode for ChannelHub.
 *
 * Runs the hub as a detached background process with PID tracking and log output.
 *
 * Commands:
 *   start   — Fork a detached child that creates ChannelHub + autoSetup()
 *   stop    — Read PID file, send SIGTERM
 *   restart — stop then start
 *   status  — Check if PID is alive
 *
 * PID file: ~/.talon/daemon.pid
 * Log file: ~/.talon/daemon.log
 */
import { spawn } from "node:child_process";
import { readFile, writeFile, unlink, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const TALON_DIR = join(homedir(), ".talon");
const PID_FILE = join(TALON_DIR, "daemon.pid");
const LOG_FILE = join(TALON_DIR, "daemon.log");
// ── Helpers ──────────────────────────────────────────────────────────────────
async function ensureTalonDir() {
    await mkdir(TALON_DIR, { recursive: true });
}
async function readPid() {
    try {
        const raw = (await readFile(PID_FILE, "utf-8")).trim();
        const pid = parseInt(raw, 10);
        return Number.isFinite(pid) ? pid : null;
    }
    catch {
        return null;
    }
}
async function writePid(pid) {
    await ensureTalonDir();
    await writeFile(PID_FILE, String(pid));
}
async function removePid() {
    try {
        await unlink(PID_FILE);
    }
    catch { }
}
function isAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
}
export async function daemonStatus() {
    const pid = await readPid();
    const running = pid !== null && isAlive(pid);
    // Clean up stale PID file
    if (pid !== null && !running)
        await removePid();
    return { running, pid: running ? pid : null, pidFile: PID_FILE, logFile: LOG_FILE };
}
// ── Stop ─────────────────────────────────────────────────────────────────────
export async function daemonStop() {
    const pid = await readPid();
    if (pid === null)
        return { stopped: false, pid: null, error: "No PID file found — daemon not running" };
    if (!isAlive(pid)) {
        await removePid();
        return { stopped: false, pid, error: "Process not running (stale PID file removed)" };
    }
    try {
        process.kill(pid, "SIGTERM");
        // Wait briefly for process to exit
        let attempts = 0;
        while (attempts < 20 && isAlive(pid)) {
            await new Promise(r => setTimeout(r, 100));
            attempts++;
        }
        if (isAlive(pid)) {
            // Force kill if SIGTERM did not work
            process.kill(pid, "SIGKILL");
        }
        await removePid();
        return { stopped: true, pid };
    }
    catch (e) {
        await removePid();
        return { stopped: false, pid, error: String(e) };
    }
}
export async function daemonStart(opts = {}) {
    // Check if already running
    const existing = await readPid();
    if (existing !== null && isAlive(existing)) {
        return { started: false, pid: existing, pidFile: PID_FILE, logFile: LOG_FILE, error: `Daemon already running (PID ${existing})` };
    }
    // Clean stale
    if (existing !== null)
        await removePid();
    await ensureTalonDir();
    // Resolve the path to the daemon worker script (compiled JS).
    // The worker is this same file — when invoked with --daemon-worker it enters worker mode.
    const thisFile = fileURLToPath(import.meta.url);
    const { openSync } = await import("node:fs");
    const logFd = openSync(LOG_FILE, "a");
    const args = ["--daemon-worker"];
    if (opts.port)
        args.push("--port", String(opts.port));
    const child = spawn(process.execPath, [thisFile, ...args], {
        detached: true,
        stdio: ["ignore", logFd, logFd],
        env: { ...process.env },
    });
    const pid = child.pid;
    if (!pid) {
        return { started: false, pid: null, pidFile: PID_FILE, logFile: LOG_FILE, error: "Failed to spawn daemon process" };
    }
    child.unref();
    await writePid(pid);
    // Give the child a moment to start so we can detect immediate crashes
    await new Promise(r => setTimeout(r, 500));
    if (!isAlive(pid)) {
        await removePid();
        return { started: false, pid, pidFile: PID_FILE, logFile: LOG_FILE, error: "Daemon process exited immediately — check " + LOG_FILE };
    }
    return { started: true, pid, pidFile: PID_FILE, logFile: LOG_FILE };
}
// ── Restart ──────────────────────────────────────────────────────────────────
export async function daemonRestart(opts = {}) {
    await daemonStop();
    return daemonStart(opts);
}
// ── Worker mode (runs inside the detached child) ─────────────────────────────
async function runWorker() {
    const args = process.argv.slice(2);
    let port;
    const portIdx = args.indexOf("--port");
    if (portIdx !== -1 && args[portIdx + 1])
        port = parseInt(args[portIdx + 1], 10);
    const timestamp = () => new Date().toISOString();
    process.stdout.write(`[${timestamp()}] Daemon worker starting (PID ${process.pid})\n`);
    // Dynamic import to avoid circular issues at top level
    const { ChannelHub } = await import("./hub.js");
    // ── The daemon is the authoritative owner of the server and channels. ──
    // We explicitly start the server and connect channels ourselves instead of
    // going through autoSetup() which would detect us via PID file and enter
    // client-only mode.  The PID file is written AFTER the server is listening
    // so that other instances checking isDaemonListening() see a consistent state.
    const hub = new ChannelHub({
        port,
        // autoStart/autoConnect are irrelevant — we do explicit setup below
        autoStart: false,
        autoConnect: false,
    });
    const resolvedPort = port ?? hub.defaultPort;
    // 1) Start the WS+HTTP server first — the daemon owns it
    await hub.startServer(resolvedPort);
    process.stdout.write(`[${timestamp()}] Server started on :${resolvedPort}\n`);
    // 2) Write PID file AFTER server is listening so isDaemonListening() sees
    //    both the PID and an accepting port atomically.
    await writePid(process.pid);
    // 3) Restore saved channel connections (Telegram, etc.) — the daemon owns channels
    const settings = await hub.loadSettings();
    const connections = await hub.getConnections();
    if (connections?.length) {
        for (const conn of connections) {
            if (!hub.clients.has(conn.url)) {
                try {
                    await hub.connect(conn.url, conn.name);
                    process.stdout.write(`[${timestamp()}] Restored channel: ${conn.url}\n`);
                }
                catch (e) {
                    process.stdout.write(`[${timestamp()}] Failed to restore channel ${conn.url}: ${e}\n`);
                }
            }
        }
    }
    // 4) If Telegram is configured but not in saved connections, connect it
    const telegramConfig = settings.transports?.telegram;
    const telegramToken = telegramConfig?.botToken ?? process.env.TELEGRAM_BOT_TOKEN;
    if (telegramToken) {
        const hasTelegram = [...hub.clients.values()].some(c => c.transport === "telegram");
        if (!hasTelegram) {
            const tgUrl = `telegram://${telegramToken}`;
            try {
                await hub.connect(tgUrl, "telegram");
                process.stdout.write(`[${timestamp()}] Connected Telegram channel\n`);
            }
            catch (e) {
                process.stdout.write(`[${timestamp()}] Telegram connection failed: ${e}\n`);
            }
        }
    }
    // 5) Start health monitor
    hub.startHealthMonitor();
    process.stdout.write(`[${timestamp()}] Daemon worker ready — hub "${hub.name}" (server :${resolvedPort}, channels: ${hub.clients.size})\n`);
    // ── Auto-spawn Claude session on incoming message ─────────────────────
    let activeSession = null;
    hub.on("message", ({ content, chatId, user, type }) => {
        if (type !== "chat")
            return;
        process.stdout.write(`[${timestamp()}] Message from ${user} (${chatId}): ${content.slice(0, 80)}\n`);
        // If no active session, spawn one
        if (!activeSession || activeSession.exitCode !== null) {
            process.stdout.write(`[${timestamp()}] No active session — spawning claude -p\n`);
            const claudeArgs = ["-c", "-p", `[From ${user} via ${chatId}]: ${content}`, "--dangerously-skip-permissions"];
            activeSession = spawn("claude", claudeArgs, {
                stdio: ["ignore", "pipe", "inherit"],
                env: { ...process.env },
                cwd: join(homedir(), ".talon"),
            });
            let response = "";
            activeSession.stdout?.on("data", (chunk) => { response += chunk.toString(); });
            activeSession.on("exit", (code) => {
                process.stdout.write(`[${timestamp()}] Claude session exited (code ${code})\n`);
                // Send response back through the channel system.
                // hub.reply() already checks channel clients by chatId before falling to No Route,
                // so this correctly routes through Telegram/WS/etc.
                if (response.trim()) {
                    const result = hub.reply(chatId, response.trim());
                    if (result.ok) {
                        process.stdout.write(`[${timestamp()}] Replied to ${chatId}: ${response.trim().slice(0, 80)}\n`);
                    }
                    else {
                        process.stdout.write(`[${timestamp()}] Reply failed for ${chatId}: ${result.error}\n`);
                    }
                }
                activeSession = null;
            });
        }
        else {
            process.stdout.write(`[${timestamp()}] Session active — queuing message\n`);
            // Could queue here for later delivery
        }
    });
    // Handle signals gracefully
    const shutdown = async (sig) => {
        process.stdout.write(`[${timestamp()}] Received ${sig}, shutting down...\n`);
        await removePid();
        process.exit(0);
    };
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));
    // Keep the event loop alive
    setInterval(() => {
        process.stdout.write(`[${timestamp()}] Daemon heartbeat — agents: ${hub.agents.size}, servers: ${hub.servers.size}, clients: ${hub.clients.size}\n`);
    }, 60000);
}
// ── Enable / Disable (auto-start on boot) ───────────────────────────────────
const PLIST_LABEL = "com.talon.architect";
const PLIST_PATH = join(homedir(), "Library", "LaunchAgents", `${PLIST_LABEL}.plist`);
const SYSTEMD_PATH = join(homedir(), ".config", "systemd", "user", "talon-architect.service");
export async function daemonEnable() {
    const thisFile = fileURLToPath(import.meta.url);
    const nodePath = process.execPath;
    if (process.platform === "darwin") {
        // macOS launchd
        const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${PLIST_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${thisFile}</string>
    <string>--daemon-worker</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${LOG_FILE}</string>
  <key>StandardErrorPath</key><string>${LOG_FILE}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/usr/local/bin:/usr/bin:/bin:${join(homedir(), ".local", "bin")}</string>
  </dict>
</dict>
</plist>`;
        try {
            await mkdir(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
            await writeFile(PLIST_PATH, plist);
            const { execSync } = await import("node:child_process");
            execSync(`launchctl load -w ${PLIST_PATH}`);
            return { enabled: true, path: PLIST_PATH };
        }
        catch (e) {
            return { enabled: false, path: PLIST_PATH, error: String(e) };
        }
    }
    else {
        // Linux systemd
        const unit = `[Unit]
Description=Talon Daemon
After=network.target

[Service]
Type=simple
ExecStart=${nodePath} ${thisFile} --daemon-worker
Restart=always
RestartSec=5
Environment=PATH=/usr/local/bin:/usr/bin:/bin:${join(homedir(), ".local", "bin")}
StandardOutput=append:${LOG_FILE}
StandardError=append:${LOG_FILE}

[Install]
WantedBy=default.target`;
        try {
            await mkdir(join(homedir(), ".config", "systemd", "user"), { recursive: true });
            await writeFile(SYSTEMD_PATH, unit);
            const { execSync } = await import("node:child_process");
            execSync("systemctl --user daemon-reload");
            execSync("systemctl --user enable talon-architect");
            execSync("systemctl --user start talon-architect");
            return { enabled: true, path: SYSTEMD_PATH };
        }
        catch (e) {
            return { enabled: false, path: SYSTEMD_PATH, error: String(e) };
        }
    }
}
export async function daemonDisable() {
    try {
        if (process.platform === "darwin") {
            const { execSync } = await import("node:child_process");
            execSync(`launchctl unload -w ${PLIST_PATH} 2>/dev/null || true`);
            await unlink(PLIST_PATH).catch(() => { });
        }
        else {
            const { execSync } = await import("node:child_process");
            execSync("systemctl --user stop talon-architect 2>/dev/null || true");
            execSync("systemctl --user disable talon-architect 2>/dev/null || true");
            await unlink(SYSTEMD_PATH).catch(() => { });
        }
        await daemonStop();
        return { disabled: true };
    }
    catch (e) {
        return { disabled: false, error: String(e) };
    }
}
// ── CLI entry point ──────────────────────────────────────────────────────────
// When this module is executed directly with --daemon-worker, enter worker mode.
if (process.argv.includes("--daemon-worker")) {
    runWorker().catch((e) => {
        process.stderr.write(`Daemon worker fatal: ${e}\n`);
        process.exit(1);
    });
}
//# sourceMappingURL=daemon.js.map