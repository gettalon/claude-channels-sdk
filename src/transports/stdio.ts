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
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import type { Transport, TransportAdapter, ConnectionHandler, MessageHandler, ProtocolMessage } from "../protocol.js";

// ── StdioTransport ──────────────────────────────────────────────────────────
// Wraps a pair of readable/writable streams as a Transport.
// Uses newline-delimited JSON, same framing as the Unix socket transport.

export class StdioTransport implements Transport {
  readonly type = "stdio";
  private _connected = true;
  private rl: ReadlineInterface | null = null;

  constructor(
    private input: NodeJS.ReadableStream,
    private output: NodeJS.WritableStream,
    private onMessage?: MessageHandler,
    private childProcess?: ChildProcess,
  ) {
    this.rl = createInterface({ input: this.input as NodeJS.ReadableStream });

    this.rl.on("line", (line) => {
      if (!line.trim()) return;
      try {
        const msg = JSON.parse(line) as ProtocolMessage;
        // Ack: send pong for non-heartbeat messages
        if (
          (msg as any).type !== "heartbeat" &&
          (msg as any).type !== "heartbeat_ack" &&
          (msg as any).type !== "ack"
        ) {
          const ref = (msg as any).call_id ?? (msg as any).chat_id ?? (msg as any).type;
          this.safeSend(JSON.stringify({ type: "ack", ref }) + "\n");
        }
        this.onMessage?.(msg);
      } catch {
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

  async send(message: ProtocolMessage): Promise<void> {
    if (!this._connected) throw new Error("Not connected");
    this.safeSend(JSON.stringify(message) + "\n");
  }

  async close(): Promise<void> {
    this._connected = false;
    this.rl?.close();
    this.rl = null;

    if (this.childProcess) {
      // Gracefully close stdin to signal the child, then kill if needed
      try {
        this.childProcess.stdin?.end();
      } catch {}
      // Give the child a moment to exit, then force-kill
      setTimeout(() => {
        if (this.childProcess && !this.childProcess.killed) {
          this.childProcess.kill();
        }
      }, 500);
    }
  }

  private safeSend(data: string): void {
    try {
      this.output.write(data);
    } catch {
      this._connected = false;
    }
  }
}

// ── StdioAdapter ────────────────────────────────────────────────────────────

export class StdioAdapter implements TransportAdapter {
  readonly type = "stdio";
  private transport: StdioTransport | null = null;
  private childProcesses: ChildProcess[] = [];

  constructor(private config: Record<string, unknown> = {}) {}

  /**
   * Listen mode — read from process.stdin, write to process.stdout.
   * Creates a single transport representing this process as a stdio server.
   * The agent itself IS the stdio process; the parent communicates via pipes.
   */
  async listen(_port: number, handler: ConnectionHandler): Promise<void> {
    // In listen mode, we ARE the child process — our stdin is input, stdout is output
    this.transport = new StdioTransport(
      process.stdin,
      process.stdout,
    );
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
  async connect(url: string, handler: MessageHandler): Promise<Transport> {
    // Parse the URL: stdio://command or stdio:///absolute/path
    let command: string;
    if (url.startsWith("stdio://")) {
      command = url.slice("stdio://".length);
    } else {
      command = url;
    }

    // Remove leading slash for absolute paths (stdio:///path becomes /path after slice)
    // But keep it if it's actually an absolute path
    // stdio://codex -> "codex"
    // stdio:///usr/bin/tool -> "/usr/bin/tool"

    const args = (this.config.args as string[] | undefined) ?? [];
    const cwd = (this.config.cwd as string | undefined) ?? process.cwd();
    const env = {
      ...process.env,
      ...((this.config.env as Record<string, string> | undefined) ?? {}),
    };
    const shell = (this.config.shell as boolean | undefined) ?? false;

    const child = spawn(command, args, {
      cwd,
      env,
      shell,
      stdio: ["pipe", "pipe", "inherit"], // pipe stdin/stdout, inherit stderr
    });

    this.childProcesses.push(child);

    const transport = new StdioTransport(
      child.stdout!,
      child.stdin!,
      handler,
      child,
    );

    // Wait for the child to be ready (first line or short delay)
    await new Promise<void>((resolve, reject) => {
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

  async close(): Promise<void> {
    if (this.transport) {
      await this.transport.close().catch(() => {});
      this.transport = null;
    }
    for (const child of this.childProcesses) {
      try {
        child.stdin?.end();
        child.kill();
      } catch {}
    }
    this.childProcesses = [];
  }
}

/** Create a stdio transport adapter */
export function createStdioTransport(config: Record<string, unknown> = {}): TransportAdapter {
  return new StdioAdapter(config);
}
