export declare class HubServerRuntime {
    private readonly hub;
    constructor(hub: any);
    /**
     * Start the hub server.
     *
     * 1. Always creates a Unix socket at /tmp/talon-{port}.sock
     * 2. Optionally starts HTTP+WS on 0.0.0.0:{port} when:
     *    - settings.server?.http === true, OR
     *    - opts.http === true passed to startServer
     *
     * Returns { port, socketPath, http: boolean }.
     */
    startServer(port?: number, opts?: {
        http?: boolean;
    }): Promise<{
        port: number;
    }>;
    /**
     * Start HTTP+WS listener on a port.
     * Can be called after initial Unix-only startup to add HTTP access.
     */
    startHttpWs(p: number): Promise<void>;
    setupAgentConnection(ws: any, addr: string): void;
    /** Complete agent registration (shared by direct register and post-approval) */
    completeRegistration(ws: any, addr: string, agentName: string, tools: any[], metadata: any, ref: {
        id: string | null;
    }): void;
}
//# sourceMappingURL=hub-server-runtime.d.ts.map