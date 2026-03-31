/**
 * Tool registry — register, list, and dispatch MCP tools.
 */
import type { ToolDefinition, McpTool, ToolContext } from "./types.js";
export declare class ToolRegistry {
    private tools;
    private ctx;
    constructor(ctx: ToolContext);
    /** Register a tool definition */
    register(def: ToolDefinition): void;
    /** Unregister a tool */
    unregister(name: string): boolean;
    /** Get a tool by name */
    get(name: string): ToolDefinition | undefined;
    /** List all tools in MCP format (for ListToolsRequestSchema) */
    list(): McpTool[];
    /** Handle a tool call (for CallToolRequestSchema) */
    handle(name: string, args: Record<string, unknown>): Promise<string>;
    /** Check if a tool exists */
    has(name: string): boolean;
    /** Get all tool names */
    names(): string[];
}
/** Helper to create text response for MCP */
export declare function text(s: any): {
    content: Array<{
        type: "text";
        text: string;
    }>;
};
//# sourceMappingURL=registry.d.ts.map