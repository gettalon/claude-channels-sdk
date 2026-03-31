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
import { type ChildProcess } from "node:child_process";
import type { Transport, TransportAdapter, ConnectionHandler, MessageHandler, ProtocolMessage } from "../protocol.js";
export declare class StdioTransport implements Transport {
    private input;
    private output;
    private onMessage?;
    private childProcess?;
    readonly type = "stdio";
    private _connected;
    private rl;
    constructor(input: NodeJS.ReadableStream, output: NodeJS.WritableStream, onMessage?: MessageHandler | undefined, childProcess?: ChildProcess | undefined);
    get connected(): boolean;
    send(message: ProtocolMessage): Promise<void>;
    close(): Promise<void>;
    private safeSend;
}
export declare class StdioAdapter implements TransportAdapter {
    private config;
    readonly type = "stdio";
    private transport;
    private childProcesses;
    constructor(config?: Record<string, unknown>);
    /**
     * Listen mode — read from process.stdin, write to process.stdout.
     * Creates a single transport representing this process as a stdio server.
     * The agent itself IS the stdio process; the parent communicates via pipes.
     */
    listen(_port: number, handler: ConnectionHandler): Promise<void>;
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
    connect(url: string, handler: MessageHandler): Promise<Transport>;
    close(): Promise<void>;
}
/** Create a stdio transport adapter */
export declare function createStdioTransport(config?: Record<string, unknown>): TransportAdapter;
//# sourceMappingURL=stdio.d.ts.map