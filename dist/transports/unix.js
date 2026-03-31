/**
 * Unix Socket Transport — fast local IPC
 *
 * No TCP overhead, no port conflicts, no network exposure.
 * Perfect for agents on the same machine.
 */
import { createServer, createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlinkSync, existsSync } from "node:fs";
const DEFAULT_SOCKET_DIR = join(tmpdir(), "talon");
class UnixTransport {
    onMessage;
    type = "unix";
    socket;
    _connected = true;
    buffer = "";
    constructor(socket, onMessage) {
        this.onMessage = onMessage;
        this.socket = socket;
        socket.on("data", (data) => {
            this.buffer += data.toString();
            // Messages are newline-delimited JSON
            const lines = this.buffer.split("\n");
            this.buffer = lines.pop();
            for (const line of lines) {
                if (!line.trim())
                    continue;
                try {
                    const msg = JSON.parse(line);
                    // Ack: send pong for non-heartbeat messages
                    if (msg.type !== "heartbeat" && msg.type !== "heartbeat_ack" && msg.type !== "ack") {
                        this.socket.write(JSON.stringify({ type: "ack", ref: msg.call_id ?? msg.chat_id ?? msg.type }) + "\n");
                    }
                    this.onMessage?.(msg);
                }
                catch { }
            }
        });
        socket.on("close", () => { this._connected = false; });
        socket.on("error", () => { this._connected = false; });
    }
    get connected() { return this._connected; }
    async send(message) {
        if (!this._connected)
            throw new Error("Not connected");
        this.socket.write(JSON.stringify(message) + "\n");
    }
    async close() {
        this._connected = false;
        this.socket.destroy();
    }
}
export class UnixSocketAdapter {
    type = "unix";
    server = null;
    socketPath;
    connections = [];
    constructor(config = {}) {
        this.socketPath = config.socketPath ?? join(DEFAULT_SOCKET_DIR, `agent-${process.pid}.sock`);
    }
    async listen(port, handler) {
        const { mkdirSync } = await import("node:fs");
        const dir = join(this.socketPath, "..");
        mkdirSync(dir, { recursive: true });
        // Clean up stale socket
        if (existsSync(this.socketPath)) {
            try {
                unlinkSync(this.socketPath);
            }
            catch { }
        }
        this.server = createServer((socket) => {
            const transport = new UnixTransport(socket);
            this.connections.push(transport);
            handler(transport);
        });
        await new Promise((resolve, reject) => {
            this.server.on("error", reject);
            this.server.listen(this.socketPath, resolve);
        });
    }
    async connect(url, handler) {
        // url is the socket path
        const socketPath = url.startsWith("unix://") ? url.slice(7) : url;
        const socket = createConnection(socketPath);
        const transport = new UnixTransport(socket, handler);
        await new Promise((resolve, reject) => {
            socket.on("connect", resolve);
            socket.on("error", reject);
        });
        return transport;
    }
    async close() {
        for (const conn of this.connections)
            await conn.close().catch(() => { });
        this.connections = [];
        if (this.server) {
            this.server.close();
            try {
                unlinkSync(this.socketPath);
            }
            catch { }
            this.server = null;
        }
    }
    /** Get the socket path for clients to connect to */
    getSocketPath() { return this.socketPath; }
}
/** Create a Unix socket transport adapter */
export function createUnixTransport(config = {}) {
    return new UnixSocketAdapter(config);
}
//# sourceMappingURL=unix.js.map