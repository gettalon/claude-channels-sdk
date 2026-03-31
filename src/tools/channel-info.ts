/**
 * channel_info tool — Show details for connections and targets.
 * Lists all addressable targets with UUIDs, connection status,
 * allow lists, and remote discovery info.
 */
import type { ToolDefinition } from "./types.js";

export const channelInfoTool: ToolDefinition = {
  name: "channel_info",
  description: "Show details for a connection or target: UUID, connection status, allow list, remote agents/groups. Use target UUID or connection name.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Connection name or target UUID to inspect. If omitted, shows all connections + targets." },
    },
    required: [],
  },
  handle: async (args, ctx) => {
    const input = args.name as string | undefined;
    const hub = ctx.hub;
    const settings = await hub.loadSettings();
    const access = settings.access ?? {};

    // Try to resolve as UUID first
    if (input) {
      const found = (hub as any).findTarget(input);
      if (found) {
        return JSON.stringify({
          uuid: found.uuid,
          name: found.name,
          kind: found.kind,
          channelType: found.channelType,
          rawId: found.rawId,
        }, null, 2);
      }
    }

    const connections: any[] = settings.connections ?? [];

    // If targeting a specific connection by name
    if (input) {
      const conn = connections.find((c: any) => c.name === input);
      if (!conn) {
        return JSON.stringify({ error: `Connection or target "${input}" not found` }, null, 2);
      }
      return JSON.stringify(buildConnDetail(conn, hub, access), null, 2);
    }

    // Show all targets + connections
    const targets: Array<{ uuid: string; name: string; kind: string }> = [];
    for (const [uuid, entry] of (hub as any).targetRegistry as Map<string, any>) {
      targets.push({ uuid, name: entry.name, kind: entry.kind });
    }
    const connDetails = connections.map((c: any) => buildConnDetail(c, hub, access));
    return JSON.stringify({
      local: { name: hub.name, allowlist: access.allowlist ?? [], requireApproval: access.requireApproval ?? false },
      targets,
      connections: connDetails,
    }, null, 2);
  },
};

function buildConnDetail(conn: any, hub: any, access: any) {
  const detail: Record<string, unknown> = {
    name: conn.name,
    url: conn.url,
    transport: conn.transport ?? guessTransport(conn.url),
    connectedAt: conn.connectedAt,
    connected: true,
  };

  if (conn.remoteInfo) {
    detail.remote = {
      server_name: conn.remoteInfo.server_name,
      agents: conn.remoteInfo.agents,
      groups: conn.remoteInfo.groups,
      chat_routes: conn.remoteInfo.chat_routes,
      cachedAt: conn.remoteInfo.cachedAt,
    };
  }

  const isHub = conn.url?.startsWith("ws://") || conn.url?.startsWith("unix://") || conn.url?.startsWith("auto://");
  if (isHub) {
    detail.access = {
      allowed: (access.allowlist ?? []).includes(conn.name),
      requireApproval: access.requireApproval ?? false,
    };
    const client = hub.clients.get(conn.url);
    if (client) {
      detail.live = { id: client.id, role: client.role };
    } else {
      detail.connected = false;
    }
  }

  return detail;
}

function guessTransport(url: string): string {
  if (url?.startsWith("ws://") || url?.startsWith("wss://")) return "websocket";
  if (url?.startsWith("unix://")) return "unix";
  if (url?.startsWith("telegram://")) return "telegram";
  if (url?.startsWith("auto://")) return "auto";
  return "unknown";
}
