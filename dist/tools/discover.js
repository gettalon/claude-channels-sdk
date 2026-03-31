import { discover } from "../protocol.js";
export const discoverTool = {
    name: "discover",
    description: "Find servers on network",
    inputSchema: { type: "object", properties: { source: { type: "string" } }, required: [] },
    handle: async (args) => {
        const r = await discover({ source: args.source });
        return JSON.stringify(r.length ? r : "No servers found", null, 2);
    },
};
//# sourceMappingURL=discover.js.map