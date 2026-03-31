/**
 * WebSocket Transport — real-time bidirectional over TCP
 *
 * Works locally and remotely. The default transport for edge agents.
 */
import type { Transport, TransportAdapter, ConnectionHandler, MessageHandler } from "@gettalon/protocol";
export declare class WebSocketAdapter implements TransportAdapter {
    private config;
    readonly type = "websocket";
    private wss;
    private httpServer;
    private connections;
    constructor(config?: Record<string, unknown>);
    listen(port: number, handler: ConnectionHandler): Promise<void>;
    connect(url: string, handler: MessageHandler): Promise<Transport>;
    close(): Promise<void>;
}
/** Create a WebSocket transport adapter */
export declare function createWebSocketTransport(config?: Record<string, unknown>): TransportAdapter;
//# sourceMappingURL=websocket.d.ts.map