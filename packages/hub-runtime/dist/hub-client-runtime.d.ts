export declare class HubClientRuntime {
    private hub;
    constructor(hub: any);
    private detectTransport;
    private isLocalUrl;
    private extractPort;
    private autoToWsUrl;
    connect(url: string, agentName?: string, connectionConfig?: Record<string, unknown>): Promise<void>;
    handleClientToolCall(msg: any, transport: any): Promise<void>;
}
//# sourceMappingURL=hub-client-runtime.d.ts.map