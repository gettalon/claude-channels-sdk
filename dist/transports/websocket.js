class WsTransport {
    onMessage;
    type = "websocket";
    ws;
    _connected = true;
    constructor(ws, onMessage) {
        this.onMessage = onMessage;
        this.ws = ws;
        if (onMessage) {
            ws.on("message", (data) => {
                try {
                    const msg = JSON.parse(data.toString());
                    // Ack: send pong for non-heartbeat messages
                    if (msg.type !== "heartbeat" && msg.type !== "heartbeat_ack" && msg.type !== "ack") {
                        try {
                            ws.send(JSON.stringify({ type: "ack", ref: msg.call_id ?? msg.chat_id ?? msg.type }));
                        }
                        catch { }
                    }
                    onMessage(msg);
                }
                catch { }
            });
        }
        ws.on("close", () => { this._connected = false; });
        ws.on("error", () => { this._connected = false; });
    }
    get connected() { return this._connected; }
    async send(message) {
        if (!this._connected)
            throw new Error("Not connected");
        this.ws.send(JSON.stringify(message));
    }
    async close() {
        this._connected = false;
        this.ws.close();
    }
}
export class WebSocketAdapter {
    config;
    type = "websocket";
    wss = null;
    httpServer = null;
    connections = [];
    constructor(config = {}) {
        this.config = config;
    }
    async listen(port, handler) {
        const { WebSocketServer } = await import("ws");
        const { createServer } = await import("node:http");
        this.httpServer = createServer();
        await new Promise((resolve, reject) => {
            this.httpServer.on("error", reject);
            this.httpServer.listen(port, "0.0.0.0", resolve);
        });
        this.wss = new WebSocketServer({ server: this.httpServer });
        this.wss.on("connection", (ws) => {
            const transport = new WsTransport(ws);
            this.connections.push(transport);
            handler(transport);
        });
    }
    async connect(url, handler) {
        const { default: WsClient } = await import("ws");
        const ws = new WsClient(url);
        const transport = new WsTransport(ws, handler);
        await new Promise((resolve, reject) => {
            ws.on("open", resolve);
            ws.on("error", reject);
        });
        return transport;
    }
    async close() {
        for (const conn of this.connections)
            await conn.close().catch(() => { });
        this.connections = [];
        if (this.wss) {
            this.wss.close();
            this.wss = null;
        }
        if (this.httpServer) {
            this.httpServer.close();
            this.httpServer = null;
        }
    }
}
/** Create a WebSocket transport adapter */
export function createWebSocketTransport(config = {}) {
    return new WebSocketAdapter(config);
}
//# sourceMappingURL=websocket.js.map