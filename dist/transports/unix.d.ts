import type { Transport, TransportAdapter, ConnectionHandler, MessageHandler } from "../protocol.js";
export declare class UnixSocketAdapter implements TransportAdapter {
    readonly type = "unix";
    private server;
    private socketPath;
    private connections;
    constructor(config?: Record<string, unknown>);
    listen(port: number, handler: ConnectionHandler): Promise<void>;
    connect(url: string, handler: MessageHandler): Promise<Transport>;
    close(): Promise<void>;
    /** Get the socket path for clients to connect to */
    getSocketPath(): string;
}
/** Create a Unix socket transport adapter */
export declare function createUnixTransport(config?: Record<string, unknown>): TransportAdapter;
//# sourceMappingURL=unix.d.ts.map