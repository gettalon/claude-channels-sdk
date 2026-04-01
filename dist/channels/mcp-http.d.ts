/**
 * MCP-over-HTTP Channel Adapter
 *
 * Exposes the ChannelServer over HTTP transport instead of stdio.
 * Supports:
 * - SSE (Server-Sent Events) for server→client streaming
 * - HTTP POST for client→server requests
 * - Compatible with MCP Streamable HTTP transport spec
 * - Multiple concurrent clients
 * - Bearer token authentication
 * - CORS support
 */
import { ChannelServer } from "../channel-server.js";
export interface McpHttpConfig {
    /** Port to listen on (default: 3100) */
    port?: number;
    /** Host to bind to (default: "127.0.0.1") */
    host?: string;
    /** Bearer token for authentication (optional) */
    bearerToken?: string;
    /** CORS allowed origins (default: "*") */
    corsOrigins?: string;
    /** Base path (default: "/mcp") */
    basePath?: string;
    /** Agent name */
    agentName?: string;
    /** Extra tools to expose */
    tools?: Array<{
        name: string;
        description: string;
        inputSchema: Record<string, unknown>;
    }>;
    /** Tool handler for incoming tool calls */
    onToolCall?: (name: string, args: Record<string, unknown>) => Promise<unknown>;
}
export declare function parseConfig(): McpHttpConfig;
export declare function createMcpHttpChannel(config?: Partial<McpHttpConfig>): Promise<{
    channel: ChannelServer;
    cleanup: () => void;
    url: string;
}>;
//# sourceMappingURL=mcp-http.d.ts.map