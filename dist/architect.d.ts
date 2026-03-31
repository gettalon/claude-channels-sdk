import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { AgentToolDef } from "./protocol.js";
export interface ArchitectOptions {
    name?: string;
    version?: string;
    instructions?: string;
    autoStart?: boolean;
    port?: number;
    autoConnect?: boolean;
    agentName?: string;
    clientTools?: AgentToolDef[];
    onToolCall?: (name: string, args: Record<string, unknown>) => Promise<unknown>;
}
export declare function createArchitectServer(opts?: ArchitectOptions): Promise<Server>;
export interface AgentMcpOptions {
    name?: string;
    version?: string;
    hubUrl?: string;
    port?: number;
}
export declare function createAgentMcpServer(opts?: AgentMcpOptions): Promise<Server>;
//# sourceMappingURL=architect.d.ts.map