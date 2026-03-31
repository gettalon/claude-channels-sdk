/**
 * Unix Socket Transport — fast local IPC
 *
 * No TCP overhead, no port conflicts, no network exposure.
 * Perfect for agents on the same machine.
 */
import { createServer, createConnection, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlinkSync, existsSync } from "node:fs";
import type { Transport, TransportAdapter, ConnectionHandler, MessageHandler, ProtocolMessage } from "@gettalon/protocol";

const DEFAULT_SOCKET_DIR = join(tmpdir(), "talon");

class UnixTransport implements Transport {
  readonly type = "unix";
  private socket: Socket;
  private _connected = true;
  private buffer = "";

  constructor(socket: Socket, private onMessage?: MessageHandler) {
    this.socket = socket;
    socket.on("data", (data) => {
      this.buffer += data.toString();
      // Messages are newline-delimited JSON
      const lines = this.buffer.split("\n");
      this.buffer = lines.pop()!;
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line) as ProtocolMessage;
          // Ack: send pong for non-heartbeat messages
          if ((msg as any).type !== "heartbeat" && (msg as any).type !== "heartbeat_ack" && (msg as any).type !== "ack") {
            this.socket.write(JSON.stringify({ type: "ack", ref: (msg as any).call_id ?? (msg as any).chat_id ?? (msg as any).type }) + "\n");
          }
          this.onMessage?.(msg);
        } catch {}
      }
    });
    socket.on("close", () => { this._connected = false; });
    socket.on("error", () => { this._connected = false; });
  }

  get connected() { return this._connected; }

  async send(message: ProtocolMessage): Promise<void> {
    if (!this._connected) throw new Error("Not connected");
    this.socket.write(JSON.stringify(message) + "\n");
  }

  async close(): Promise<void> {
    this._connected = false;
    this.socket.destroy();
  }
}

export class UnixSocketAdapter implements TransportAdapter {
  readonly type = "unix";
  private server: Server | null = null;
  private socketPath: string;
  private connections: UnixTransport[] = [];

  constructor(config: Record<string, unknown> = {}) {
    this.socketPath = (config.socketPath as string) ?? join(DEFAULT_SOCKET_DIR, `agent-${process.pid}.sock`);
  }

  async listen(port: number, handler: ConnectionHandler): Promise<void> {
    const { mkdirSync } = await import("node:fs");
    const dir = join(this.socketPath, "..");
    mkdirSync(dir, { recursive: true });

    // Clean up stale socket
    if (existsSync(this.socketPath)) {
      try { unlinkSync(this.socketPath); } catch {}
    }

    this.server = createServer((socket) => {
      const transport = new UnixTransport(socket);
      this.connections.push(transport);
      handler(transport);
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.on("error", reject);
      this.server!.listen(this.socketPath, resolve);
    });
  }

  async connect(url: string, handler: MessageHandler): Promise<Transport> {
    // url is the socket path
    const socketPath = url.startsWith("unix://") ? url.slice(7) : url;
    const socket = createConnection(socketPath);
    const transport = new UnixTransport(socket, handler);
    await new Promise<void>((resolve, reject) => {
      socket.on("connect", resolve);
      socket.on("error", reject);
    });
    return transport;
  }

  async close(): Promise<void> {
    for (const conn of this.connections) await conn.close().catch(() => {});
    this.connections = [];
    if (this.server) {
      this.server.close();
      try { unlinkSync(this.socketPath); } catch {}
      this.server = null;
    }
  }

  /** Get the socket path for clients to connect to */
  getSocketPath(): string { return this.socketPath; }
}

/** Create a Unix socket transport adapter */
export function createUnixTransport(config: Record<string, unknown> = {}): TransportAdapter {
  return new UnixSocketAdapter(config);
}
