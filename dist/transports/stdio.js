/**
 * Stdio Transport — pipe-based IPC via stdin/stdout
 *
 * No network, no sockets — just stdin/stdout JSON lines.
 * Perfect for spawning CLI tools (codex, etc.) as child processes,
 * or running agents as stdin/stdout processes.
 *
 * Usage:
 *   connect stdio://codex        — spawn "codex" and communicate via pipes
 *   connect stdio:///path/to/tool — spawn an absolute-path CLI tool
 *   listen (server mode)         — read from process.stdin, multiplex sessions
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
// ── StdioTransport ──────────────────────────────────────────────────────────
// Wraps a pair of readable/writable streams as a Transport.
// Uses newline-delimited JSON, same framing as the Unix socket transport.
export class StdioTransport {
    input;
    output;
    onMessage;
    childProcess;
    type = "stdio";
    _connected = true;
    rl = null;
    constructor(input, output, onMessage, childProcess) {
        this.input = input;
        this.output = output;
        this.onMessage = onMessage;
        this.childProcess = childProcess;
        this.rl = createInterface({ input: this.input });
        this.rl.on("line", (line) => {
            if (!line.trim())
                return;
            try {
                const msg = JSON.parse(line);
                // Ack: send pong for non-heartbeat messages
                if (msg.type !== "heartbeat" &&
                    msg.type !== "heartbeat_ack" &&
                    msg.type !== "ack") {
                    const ref = msg.call_id ?? msg.chat_id ?? msg.type;
                    this.safeSend(JSON.stringify({ type: "ack", ref }) + "\n");
                }
                this.onMessage?.(msg);
            }
            catch {
                // Ignore non-JSON lines (e.g. debug output from child)
            }
        });
        this.rl.on("close", () => {
            this._connected = false;
        });
        // Handle child process exit
        if (this.childProcess) {
            this.childProcess.on("exit", () => {
                this._connected = false;
            });
            this.childProcess.on("error", () => {
                this._connected = false;
            });
        }
    }
    get connected() {
        return this._connected;
    }
    async send(message) {
        if (!this._connected)
            throw new Error("Not connected");
        this.safeSend(JSON.stringify(message) + "\n");
    }
    async close() {
        this._connected = false;
        this.rl?.close();
        this.rl = null;
        if (this.childProcess) {
            // Gracefully close stdin to signal the child, then kill if needed
            try {
                this.childProcess.stdin?.end();
            }
            catch { }
            // Give the child a moment to exit, then force-kill
            setTimeout(() => {
                if (this.childProcess && !this.childProcess.killed) {
                    this.childProcess.kill();
                }
            }, 500);
        }
    }
    safeSend(data) {
        try {
            this.output.write(data);
        }
        catch {
            this._connected = false;
        }
    }
}
// ── StdioAdapter ────────────────────────────────────────────────────────────
export class StdioAdapter {
    config;
    type = "stdio";
    transport = null;
    childProcesses = [];
    constructor(config = {}) {
        this.config = config;
    }
    /**
     * Listen mode — read from process.stdin, write to process.stdout.
     * Creates a single transport representing this process as a stdio server.
     * The agent itself IS the stdio process; the parent communicates via pipes.
     */
    async listen(_port, handler) {
        // In listen mode, we ARE the child process — our stdin is input, stdout is output
        this.transport = new StdioTransport(process.stdin, process.stdout);
        handler(this.transport);
    }
    /**
     * Connect mode — spawn a child process and communicate via its stdin/stdout.
     *
     * URL formats:
     *   stdio://codex             — spawn "codex" (found in PATH)
     *   stdio:///usr/local/bin/tool — spawn absolute path
     *   stdio://node -- script.js  — spawn with arguments (via config.args)
     *
     * Config options:
     *   args: string[]   — extra arguments for the child process
     *   cwd: string      — working directory for the child
     *   env: object      — extra environment variables
     *   shell: boolean   — run in shell (default: false)
     */
    async connect(url, handler) {
        // Parse the URL: stdio://command or stdio:///absolute/path
        let command;
        if (url.startsWith("stdio://")) {
            command = url.slice("stdio://".length);
        }
        else {
            command = url;
        }
        // Remove leading slash for absolute paths (stdio:///path becomes /path after slice)
        // But keep it if it's actually an absolute path
        // stdio://codex -> "codex"
        // stdio:///usr/bin/tool -> "/usr/bin/tool"
        const args = this.config.args ?? [];
        const cwd = this.config.cwd ?? process.cwd();
        const env = {
            ...process.env,
            ...(this.config.env ?? {}),
        };
        const shell = this.config.shell ?? false;
        const child = spawn(command, args, {
            cwd,
            env,
            shell,
            stdio: ["pipe", "pipe", "inherit"], // pipe stdin/stdout, inherit stderr
        });
        this.childProcesses.push(child);
        const transport = new StdioTransport(child.stdout, child.stdin, handler, child);
        // Wait for the child to be ready (first line or short delay)
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                // Child started successfully (no immediate crash)
                resolve();
            }, 200);
            child.on("error", (err) => {
                clearTimeout(timeout);
                reject(new Error(`Failed to spawn "${command}": ${err.message}`));
            });
            // If child exits immediately, that's an error
            child.on("exit", (code) => {
                if (code !== null && code !== 0) {
                    clearTimeout(timeout);
                    reject(new Error(`Child "${command}" exited immediately with code ${code}`));
                }
            });
        });
        return transport;
    }
    async close() {
        if (this.transport) {
            await this.transport.close().catch(() => { });
            this.transport = null;
        }
        for (const child of this.childProcesses) {
            try {
                child.stdin?.end();
                child.kill();
            }
            catch { }
        }
        this.childProcesses = [];
    }
}
/** Create a stdio transport adapter */
export function createStdioTransport(config = {}) {
    return new StdioAdapter(config);
}
//# sourceMappingURL=stdio.js.map