/**
 * start_server tool — Start HTTP+WS server.
 */
import type { ToolDefinition } from "./types.js";

export const startServerTool: ToolDefinition = {
  name: "start_server",
  description: "Start HTTP+WS server",
  inputSchema: {
    type: "object",
    properties: {
      port: { type: "number", description: "Port to listen on (default: hub's defaultPort)" },
    },
    required: [],
  },
  handle: async (args, ctx) => {
    const hub = ctx.hub;
    const port = (args.port as number | undefined) ?? hub.defaultPort;

    // Register WS server entry in settings so autoSetup starts it on next boot
    const settings = await hub.loadSettings();
    const servers: any[] = (settings as any).servers ?? [];
    const wsUrl = `ws://127.0.0.1:${port}`;
    if (!servers.some((s: any) => s.url === wsUrl)) {
      servers.push({ url: wsUrl, name: hub.name, port, type: "ws" });
      (settings as any).servers = servers;
      await hub.saveSettings(settings);
    }

    // If unix already running, start HTTP+WS directly
    if (hub.hasServer(`unix:${port}`) && !hub.hasServer(`ws:${port}`)) {
      try {
        await hub.startHttpWs(port);
        return JSON.stringify({ port, ws: true });
      } catch (e: any) {
        return JSON.stringify({ error: e?.message ?? String(e) });
      }
    }
    const result = await hub.startServer(port, { http: true });
    return JSON.stringify(result, null, 2);
  },
};
