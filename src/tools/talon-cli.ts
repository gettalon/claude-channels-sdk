import type { ToolDefinition } from "./types.js";
import { launchAgent, stopAgent, listRunningAgents } from "./agent-launcher.js";

/** Safe read of agent.json metadata (never throws). */
async function readAgentMetaSafe(name: string): Promise<any> {
  try {
    const { readFileSync } = await import("node:fs");
    const { join: joinPath } = await import("node:path");
    const { homedir } = await import("node:os");
    return JSON.parse(readFileSync(joinPath(homedir(), ".talon", "agents", name, "agent.json"), "utf-8"));
  } catch { return {}; }
}

export const talonCliTool: ToolDefinition = {
  name: "talon",
  description: "CLI: status, ls (agents+channels), connect, send, call, register, reload, server, discover, daemon, approve, deny, pending, handover, release, routes, health, group, contacts, contact, version, update, launch, stop",
  inputSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
  handle: async (args, ctx) => {
    const cmd = (args.command as string).trim();
    const parts = cmd.split(/\s+/);
    const action = parts[0]?.toLowerCase();
    const rest = parts.slice(1).join(" ");
    const hub = ctx.hub;
    const mcp = ctx.mcp;

    if (action === "status" || action === "s") return JSON.stringify(hub.getStatus(), null, 2);

    if (action === "agents" || action === "ls" || action === "a") {
      const lines: string[] = [];
      const host = (await import("node:os")).hostname().split(".")[0];
      const persistent = await listRunningAgents();
      if (persistent.length) {
        lines.push(`LOCAL @${host}`);
        for (const a of persistent) {
          const meta = await readAgentMetaSafe(a.name);
          const model = (a as any).model || meta.model || "";
          const icon = a.status === "running" ? "+" : a.status === "error" ? "!" : "-";
          lines.push(`  ${icon} ${a.name.padEnd(14)} ${a.status.padEnd(8)} ${model}`);
        }
      }
      const wsAgents = await Promise.resolve(hub.listAgents());
      const wsFiltered = Array.isArray(wsAgents) ? wsAgents : [];
      if (wsFiltered.length) {
        lines.push("REMOTE");
        for (const a of wsAgents as any[]) {
          const isPeer = a.isPeer ? "(peer)" : "";
          lines.push(`  + ${a.name.padEnd(14)} ${isPeer}`);
        }
      }
      const settings = await hub.loadSettings().catch(() => ({}));
      const connections = (settings as any).connections || [];
      if (connections.length) {
        const byType = new Map<string, any[]>();
        for (const c of connections) {
          const type = c.url?.match(/^(\w+):/)?.[1] || "unknown";
          if (!byType.has(type)) byType.set(type, []);
          byType.get(type)!.push(c);
        }
        lines.push("CHANNELS");
        for (const [type, conns] of byType) {
          lines.push(`  ${type} (${conns.length})`);
        }
      }
      return lines.length ? lines.join("\n") : "No agents or channels";
    }

    if (action === "channels" || action === "ch") { const { listChannels } = await import("../protocol.js"); return JSON.stringify(listChannels(), null, 2); }
    if (action === "connect" || action === "c") { if (!rest) return "Usage: connect <url> [name]"; const [url, n] = rest.split(/\s+/); await hub.connect(url, n); return JSON.stringify({ connected: url }); }
    if (action === "send" || action === "msg") { const m = rest.match(/^(\S+)\s+([\s\S]+)$/); if (!m) return "Usage: send <target> <msg>"; return JSON.stringify(hub.sendMessage(m[1], m[2])); }
    if (action === "reply" || action === "r") { const m = rest.match(/^(\S+)\s+([\s\S]+)$/); if (!m) return "Usage: reply <chat_id> <text> [--tts]"; const tts = m[2].includes("--tts"); const msg = m[2].replace(/\s*--tts\s*/g, "").trim(); return JSON.stringify(hub.reply(m[1], msg, tts ? { meta: { tts: "true" } } as any : undefined)); }
    if (action === "call") { const m = rest.match(/^(\S+)\s+(\S+)(?:\s+([\s\S]+))?$/); if (!m) return "Usage: call <agent> <tool> [args]"; try { return JSON.stringify(await hub.callRemoteTool(hub.findAgent(m[1])?.id ?? m[1], m[2], m[3] ? JSON.parse(m[3]) : {}), null, 2); } catch (e) { return JSON.stringify({ error: String(e) }); } }
    if (action === "register" || action === "reg") { const m = rest.match(/^(\S+)(?:\s+([\s\S]+))?$/); if (!m) return "Usage: register <type> [config]"; const c = m[2] ? JSON.parse(m[2]) : {}; if (Object.keys(c).length) { const s = await hub.loadSettings(); s.transports = s.transports ?? {}; s.transports[m[1]] = { ...(s.transports[m[1]] ?? {}), ...c }; await hub.saveSettings(s); } return JSON.stringify({ registered: m[1] }); }
    if (action === "reload") { return JSON.stringify(await hub.reload(), null, 2); }
    if (action === "server" || action === "start") { return JSON.stringify(await hub.startServer(parseInt(rest) || undefined), null, 2); }
    if (action === "discover" || action === "scan") { const { discover } = await import("../protocol.js"); const r = await discover({ source: (rest as any) || "all" }); return JSON.stringify(r.length ? r : "No servers found"); }
    if (action === "approve") { if (!rest) return "Usage: approve <code>"; return JSON.stringify(await hub.approveAgent(rest.trim()), null, 2); }
    if (action === "deny") { if (!rest) return "Usage: deny <code>"; return JSON.stringify(hub.denyAgent(rest.trim()), null, 2); }
    if (action === "pending") { const list = hub.listPendingAgents(); return JSON.stringify(list.length ? list : "No pending approvals"); }
    if (action === "handover" || action === "ho") { const m = rest.match(/^(\S+)\s+(\S+)$/); if (!m) return "Usage: handover <chat_id> <agent_id>"; return JSON.stringify(await Promise.resolve(hub.handover(m[1], m[2])), null, 2); }
    if (action === "release" || action === "rel") { if (!rest) return "Usage: release <chat_id>"; return JSON.stringify(await Promise.resolve(hub.releaseChat(rest.trim())), null, 2); }
    if (action === "health" || action === "h") { return JSON.stringify(await hub.getHealth(), null, 2); }
    if (action === "routes") {
      if (hub.isClient()) return "Routes are managed by the server.";
      const routes = [...hub.chatRoutes.entries()].map(([chatId, agentId]) => ({ chatId, agentId, agentName: hub.agents.get(agentId)?.name ?? "unknown" }));
      return JSON.stringify(routes.length ? routes : "No chat routes", null, 2);
    }
    if (action === "daemon" || action === "d") {
      const subParts = rest.split(/\s+/);
      const sub = subParts[0]?.toLowerCase();
      const { daemonStart, daemonStop, daemonRestart, daemonStatus, daemonEnable, daemonDisable } = await import("../daemon.js");
      if (sub === "start") { return JSON.stringify(await daemonStart({ port: parseInt(subParts[1]) || undefined }), null, 2); }
      if (sub === "stop") { return JSON.stringify(await daemonStop(), null, 2); }
      if (sub === "restart") { return JSON.stringify(await daemonRestart({ port: parseInt(subParts[1]) || undefined }), null, 2); }
      if (sub === "status") { return JSON.stringify(await daemonStatus(), null, 2); }
      if (sub === "enable") { return JSON.stringify(await daemonEnable(), null, 2); }
      if (sub === "disable") { return JSON.stringify(await daemonDisable(), null, 2); }
      return "Usage: daemon start|stop|restart|status|enable|disable";
    }
    if (action === "group" || action === "g") {
      const groupParts = rest.split(/\s+/);
      const sub = groupParts[0]?.toLowerCase();
      const groupRest = groupParts.slice(1).join(" ");
      if (sub === "create") { if (!groupRest) return "Usage: group create <name>"; return JSON.stringify(await Promise.resolve(hub.createGroup(groupRest.trim())), null, 2); }
      if (sub === "add") { const m = groupRest.match(/^(\S+)\s+(\S+)$/); if (!m) return "Usage: group add <name> <agent>"; return JSON.stringify(await Promise.resolve(hub.addToGroup(m[1], m[2])), null, 2); }
      if (sub === "remove") { const m = groupRest.match(/^(\S+)\s+(\S+)$/); if (!m) return "Usage: group remove <name> <agent>"; return JSON.stringify(await Promise.resolve(hub.removeFromGroup(m[1], m[2])), null, 2); }
      if (sub === "delete") { if (!groupRest) return "Usage: group delete <name>"; return JSON.stringify(await Promise.resolve(hub.deleteGroup(groupRest.trim())), null, 2); }
      if (sub === "list" || sub === "ls") { return JSON.stringify(await Promise.resolve(hub.listGroups()), null, 2); }
      if (sub === "send") { const m = groupRest.match(/^(\S+)\s+([\s\S]+)$/); if (!m) return "Usage: group send <name> <message>"; return JSON.stringify(await Promise.resolve(hub.broadcastToGroup(m[1], m[2], ctx.serverName)), null, 2); }
      return "Usage: group create|add|remove|delete|list|send";
    }
    if (action === "contacts") { return JSON.stringify(hub.listContacts(), null, 2); }
    if (action === "contact") {
      const contactParts = rest.split(/\s+/);
      const sub = contactParts[0]?.toLowerCase();
      const contactRest = contactParts.slice(1);
      if (sub === "add") { if (contactRest.length < 3) return "Usage: contact add <name> <channel> <id>"; return JSON.stringify(hub.registerContact(contactRest[0], contactRest[1], contactRest[2])); }
      if (sub === "remove" || sub === "rm") { if (!contactRest[0]) return "Usage: contact remove <name>"; return JSON.stringify(hub.removeContact(contactRest[0])); }
      return "Usage: contact add <name> <channel> <id> | contact remove <name>";
    }
    if (action === "launch") {
      const launchParts = rest.split(/\s+/);
      const agentName = launchParts[0];
      if (!agentName) return "Usage: launch <name> [--mode master|bypass|direct] [--prompt \"...\"] [--bot-token TOKEN]";
      const launchOpts: { mode?: "master" | "bypass" | "direct"; prompt?: string; botToken?: string } = {};
      for (let i = 1; i < launchParts.length; i++) {
        if (launchParts[i] === "--mode" && launchParts[i + 1]) { launchOpts.mode = launchParts[++i] as any; }
        else if (launchParts[i] === "--prompt" && launchParts[i + 1]) { launchOpts.prompt = launchParts[++i]; }
        else if (launchParts[i] === "--bot-token" && launchParts[i + 1]) { launchOpts.botToken = launchParts[++i]; }
      }
      const result = await launchAgent(agentName, {
        ...launchOpts,
        onOutput: (agentName, text, chatId) => {
          if (chatId) hub.reply(chatId, `[${agentName}] ${text}`);
          hub.emit("message", { content: `[${agentName}] ${text}`, chatId: chatId ?? "host", user: agentName, type: "chat", source: ctx.serverName });
        },
      });
      return JSON.stringify(result, null, 2);
    }
    if (action === "stop") { if (!rest) return "Usage: stop <name>"; return JSON.stringify(await stopAgent(rest.trim()), null, 2); }
    if (action === "version" || action === "v") { return JSON.stringify({ version: (await import("../hub.js")).ChannelHub.getVersion() || "unknown", package: "@gettalon/channels-sdk" }); }
    if (action === "update" || action === "upgrade") {
      const info = await hub.autoUpdate();
      if (info.updated) return JSON.stringify({ updated: true, from: info.currentVersion, to: info.latestVersion, message: "Restart to use the new version." });
      if (!info.updateAvailable) return JSON.stringify({ updated: false, currentVersion: info.currentVersion, message: "Already on the latest version." });
      return JSON.stringify({ updated: false, currentVersion: info.currentVersion, latestVersion: info.latestVersion, message: "Update failed. Check stderr for details." });
    }
    return JSON.stringify({ error: `Unknown: ${action}. Try: status, ls, channels, connect, send, call, register, reload, server, discover, daemon, approve, deny, pending, handover, release, routes, health, group, contacts, contact, version, update, launch, stop` });
  },
};
