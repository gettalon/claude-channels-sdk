export const targetsTool = {
    name: "targets",
    description: "List available targets (UUIDs + names) this agent can send to. Filtered by allow list, same as approval logic.",
    inputSchema: { type: "object", properties: {}, required: [] },
    handle: async (_args, ctx) => {
        const hub = ctx.hub;
        const settings = await hub.loadSettings();
        const access = settings.access ?? {};
        const allowlist = access.allowlist ?? [];
        const registry = hub.targetRegistry;
        if (!registry) {
            return JSON.stringify({ error: "Target registry not available" });
        }
        const targets = [];
        for (const [uuid, entry] of registry) {
            // Apply same allow-list logic as connect approval:
            // - If requireApproval is off, everything is visible
            // - If requireApproval is on, only allowlist matches are visible
            const requireApproval = access.requireApproval === true;
            if (!requireApproval || allowlist.some((a) => {
                if (a === entry.name || a === uuid)
                    return true;
                if (a.includes("*")) {
                    const pattern = new RegExp("^" + a.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
                    return pattern.test(entry.name) || pattern.test(uuid);
                }
                if (a.endsWith(":") && uuid.startsWith(a))
                    return true;
                return false;
            })) {
                targets.push({
                    uuid,
                    name: entry.name,
                    kind: entry.kind,
                    channelType: entry.channelType,
                });
            }
        }
        // Add connected agents (addressable by their raw UUID from list_agents)
        for (const [id, agent] of hub.agents) {
            targets.push({ uuid: id, name: agent.name, kind: "agent", channelType: "agent" });
        }
        // Add local connections with their remote targets
        const connections = settings.connections ?? [];
        const connTargets = connections
            .filter((c) => c.remoteInfo)
            .map((c) => ({
            connection: c.name,
            url: c.url,
            agents: c.remoteInfo.agents?.map((a) => ({ uuid: a.id, name: a.name })),
            groups: c.remoteInfo.groups?.map((g) => ({ name: g.name, members: g.members })),
        }))
            .filter((c) => c.agents?.length || c.groups?.length);
        return JSON.stringify({
            local: targets,
            remote: connTargets.length > 0 ? connTargets : undefined,
        }, null, 2);
    },
};
//# sourceMappingURL=targets.js.map