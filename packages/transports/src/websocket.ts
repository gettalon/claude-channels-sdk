/**
 * WebSocket Transport — real-time bidirectional over TCP
 *
 * Works locally and remotely. The default transport for edge agents.
 */
import type { Transport, TransportAdapter, ConnectionHandler, MessageHandler, ProtocolMessage } from "@gettalon/protocol";

class WsTransport implements Transport {
  readonly type = "websocket";
  private ws: any;
  private _connected = true;

  constructor(ws: any, private onMessage?: MessageHandler) {
    this.ws = ws;
    if (onMessage) {
      ws.on("message", (data: Buffer | string) => {
        try {
          const msg = JSON.parse(data.toString()) as ProtocolMessage;
          // Ack: send pong for non-heartbeat messages
          if ((msg as any).type !== "heartbeat" && (msg as any).type !== "heartbeat_ack" && (msg as any).type !== "ack") {
            try { ws.send(JSON.stringify({ type: "ack", ref: (msg as any).call_id ?? (msg as any).chat_id ?? (msg as any).type })); } catch {}
          }
          onMessage(msg);
        } catch {}
      });
    }
    ws.on("close", () => { this._connected = false; });
    ws.on("error", () => { this._connected = false; });
  }

  get connected() { return this._connected; }

  async send(message: ProtocolMessage): Promise<void> {
    if (!this._connected) throw new Error("Not connected");
    this.ws.send(JSON.stringify(message));
  }

  async close(): Promise<void> {
    this._connected = false;
    this.ws.close();
  }
}

export class WebSocketAdapter implements TransportAdapter {
  readonly type = "websocket";
  private wss: any = null;
  private httpServer: any = null;
  private connections: WsTransport[] = [];

  constructor(private config: Record<string, unknown> = {}) {}

  async listen(port: number, handler: ConnectionHandler): Promise<void> {
    const { WebSocketServer } = await import("ws");
    const { createServer } = await import("node:http");

    this.httpServer = createServer();
    await new Promise<void>((resolve, reject) => {
      this.httpServer.on("error", reject);
      this.httpServer.listen(port, "127.0.0.1", resolve);
    });

    this.wss = new WebSocketServer({ server: this.httpServer });
    this.wss.on("connection", (ws: any) => {
      const transport = new WsTransport(ws);
      this.connections.push(transport);
      handler(transport);
    });
  }

  async connect(url: string, handler: MessageHandler): Promise<Transport> {
    const { default: WsClient } = await import("ws");
    const ws = new WsClient(url);
    const transport = new WsTransport(ws, handler);
    await new Promise<void>((resolve, reject) => {
      ws.on("open", resolve);
      ws.on("error", reject);
    });
    return transport;
  }

  async close(): Promise<void> {
    for (const conn of this.connections) await conn.close().catch(() => {});
    this.connections = [];
    if (this.wss) { this.wss.close(); this.wss = null; }
    if (this.httpServer) { this.httpServer.close(); this.httpServer = null; }
  }
}

/** Create a WebSocket transport adapter */
export function createWebSocketTransport(config: Record<string, unknown> = {}): TransportAdapter {
  return new WebSocketAdapter(config);
}
