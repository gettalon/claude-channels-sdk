export class ToolRegistry {
    tools = new Map();
    ctx;
    constructor(ctx) {
        this.ctx = ctx;
    }
    /** Register a tool definition */
    register(def) {
        this.tools.set(def.name, def);
    }
    /** Unregister a tool */
    unregister(name) {
        return this.tools.delete(name);
    }
    /** Get a tool by name */
    get(name) {
        return this.tools.get(name);
    }
    /** List all tools in MCP format (for ListToolsRequestSchema) */
    list() {
        return [...this.tools.values()].map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
        }));
    }
    /** Handle a tool call (for CallToolRequestSchema) */
    async handle(name, args) {
        const tool = this.tools.get(name);
        if (!tool) {
            throw new Error(`Unknown tool: ${name}`);
        }
        return tool.handle(args ?? {}, this.ctx);
    }
    /** Check if a tool exists */
    has(name) {
        return this.tools.has(name);
    }
    /** Get all tool names */
    names() {
        return [...this.tools.keys()];
    }
}
/** Helper to create text response for MCP */
export function text(s) {
    return {
        content: [{
                type: "text",
                text: typeof s === "string" ? s : JSON.stringify(s, null, 2),
            }],
    };
}
//# sourceMappingURL=registry.js.map