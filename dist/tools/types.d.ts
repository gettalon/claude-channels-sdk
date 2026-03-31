/**
 * Tool types for MCP tool registry.
 */
import type { ChannelHub } from "../hub.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
/** Context passed to tool handlers */
export interface ToolContext {
    hub: ChannelHub;
    serverName: string;
    mcp: Server;
}
/** Definition of an MCP tool */
export interface ToolDefinition {
    name: string;
    description: string;
    inputSchema: Record<string, any>;
    /** Optional list of required parameter names */
    required?: string[];
    /** Handler for the tool — returns text response */
    handle: (args: Record<string, unknown>, ctx: ToolContext) => Promise<string> | string;
}
/** Format for MCP tool list response */
export interface McpTool {
    name: string;
    description: string;
    inputSchema: Record<string, any>;
}
//# sourceMappingURL=types.d.ts.map