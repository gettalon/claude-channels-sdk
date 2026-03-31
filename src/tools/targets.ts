/**
 * targets tool — List available targets (UUIDs + names) for the current agent.
 * Uses the same allow-list logic as approval to filter what this agent can reach.
 */
import type { ToolDefinition } from "./types.js";

export const targetsTool: ToolDefinition = {
  name: "targets",
  description: "List available targets (UUIDs + names) this agent can send to. Filtered by allow list, same as approval logic.",
  inputSchema: { type: "object", properties: {}, required: [] },
  handle: async (_args, ctx) => {
    const hub = ctx.hub;
    const settings = await hub.loadSettings();
    const access = settings.access ?? {};
    const allowlist: string[] = access.allowlist ?? [];
    const registry = (hub as any).targetRegistry as Map<string, any> | undefined;

    if (!registry) {
      return JSON.stringify({ error: "Target registry not available" });
    }

    const targets: Array<{ uuid: string; name: string; kind: string; channelType: string }> = [];

    for (const [uuid, entry] of registry) {
      // Apply same allow-list logic as connect approval:
      // - If requireApproval is off, everything is visible
      // - If requireApproval is on, only allowlist matches are visible
      const requireApproval = access.requireApproval === true;
      if (!requireApproval || allowlist.some((a: string) => {
        if (a === entry.name || a === uuid) return true;
        if (a.includes("*")) {
          const pattern = new RegExp("^" + a.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
          return pattern.test(entry.name) || pattern.test(uuid);
        }
        if (a.endsWith(":") && uuid.startsWith(a)) return true;
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

    // Add connected agents — use hub.listAgents() so client hubs see daemon's agents too
    const agentList = (await Promise.resolve(hub.listAgents())) as any[];
    for (const agent of agentList) {
      if (!targets.some(t => t.uuid === agent.id)) {
        targets.push({ uuid: agent.id, name: agent.name, kind: "agent", channelType: "agent" });
      }
    }

    // Add local connections with their remote targets
    const connections: any[] = settings.connections ?? [];
    const connTargets = connections
      .filter((c: any) => c.remoteInfo)
      .map((c: any) => ({
        connection: c.name,
        url: c.url,
        agents: c.remoteInfo.agents?.map((a: any) => ({ uuid: a.id, name: a.name })),
        groups: c.remoteInfo.groups?.map((g: any) => ({ name: g.name, members: g.members })),
      }))
      .filter((c: any) => c.agents?.length || c.groups?.length);

    return JSON.stringify({
      local: targets,
      remote: connTargets.length > 0 ? connTargets : undefined,
    }, null, 2);
  },
};
