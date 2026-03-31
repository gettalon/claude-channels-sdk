/**
 * Tool registry — register, list, and dispatch MCP tools.
 */
import type { ToolDefinition, McpTool, ToolContext } from "./types.js";

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();
  private ctx: ToolContext;

  constructor(ctx: ToolContext) {
    this.ctx = ctx;
  }

  /** Register a tool definition */
  register(def: ToolDefinition): void {
    this.tools.set(def.name, def);
  }

  /** Unregister a tool */
  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  /** Get a tool by name */
  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  /** List all tools in MCP format (for ListToolsRequestSchema) */
  list(): McpTool[] {
    return [...this.tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
  }

  /** Handle a tool call (for CallToolRequestSchema) */
  async handle(name: string, args: Record<string, unknown>): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`Unknown tool: ${name}`);
    }
    return tool.handle(args ?? {}, this.ctx);
  }

  /** Check if a tool exists */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** Get all tool names */
  names(): string[] {
    return [...this.tools.keys()];
  }
}

/** Helper to create text response for MCP */
export function text(s: any): { content: Array<{ type: "text"; text: string }> } {
  return {
    content: [{
      type: "text" as const,
      text: typeof s === "string" ? s : JSON.stringify(s, null, 2),
    }],
  };
}
