/**
 * Edge Agent Server — thin MCP wrapper around ChannelHub.
 *
 * All connection management, routing, heartbeat, dedup, settings
 * are handled by ChannelHub (SDK level). This file just exposes
 * MCP tools (via ToolRegistry) and wires up channel notifications.
 *
 * Usage:
 *   import { createArchitectServer } from "@gettalon/channels-sdk";
 *   await createArchitectServer();
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { ChannelHub } from "./hub.js";
import type { AgentToolDef } from "./protocol.js";
import { ToolRegistry, text } from "./tools/registry.js";
import { registerBuiltinTools } from "./tools/index.js";
import { getAgent, sendToAgent, listRunningAgents } from "./tools/agent-launcher.js";
import { HubConfigService } from "@gettalon/hub-runtime";

export interface ArchitectOptions {
  name?: string;
  version?: string;
  instructions?: string;
  autoStart?: boolean;
  port?: number;
  autoConnect?: boolean;
  agentName?: string;
  clientTools?: AgentToolDef[];
  onToolCall?: (name: string, args: Record<string, unknown>) => Promise<unknown>;
}

export async function createArchitectServer(opts: ArchitectOptions = {}): Promise<Server> {
  // Merge env-var overrides via HubConfigService for centralized config
  const cfg = HubConfigService.fromEnv();
  const merged: ArchitectOptions = {
    ...opts,
    name: opts.name ?? cfg.envAgentName,
    port: opts.port ?? cfg.envPort,
    agentName: opts.agentName ?? cfg.envAgentName,
  };
  const hub = new ChannelHub(merged);
  const serverName = hub.name;

  // Wire persistent agent router so @agent mentions in smart routing can reach SDK agents
  // Also handles stopped agents by buffering messages for delivery on relaunch
  (hub as any)._persistentAgentRouter = (name: string, content: string, from: string, chatId: string): boolean => {
    const agent = getAgent(name);
    // Agent is running — send directly
    if (agent && agent.status === "running" && agent.sendMessage) {
      sendToAgent(name, content, from, chatId);
      return true;
    }
    // Agent is stopped but exists (has a folder) — buffer for later delivery
    // Check if agent folder exists on disk
    const { existsSync } = require("node:fs");
    const { join: joinPath, homedir } = require("node:os");
    const agentFolder = joinPath(homedir(), ".talon", "agents", name);
    if (existsSync(agentFolder)) {
      const result = sendToAgent(name, content, from, chatId);
      if (result.buffered) {
        process.stderr.write(`[${serverName}] Buffered message for stopped agent "${name}"\n`);
      }
      return true;
    }
    return false;
  };

  // ── Load architect template for MCP instructions ─────────────────────
  let architectInstructions = "";
  try {
    const { readFileSync } = await import("node:fs");
    const { join: joinPath } = await import("node:path");
    // Try templates/architect/CLAUDE.md from SDK root
    const tplPath = joinPath(new URL(".", import.meta.url).pathname, "..", "templates", "architect", "CLAUDE.md");
    architectInstructions = readFileSync(tplPath, "utf-8")
      .replace(/\{\{port\}\}/g, String((hub as any).opts?.port ?? 9090))
      .replace(/\{\{owner_id\}\}/g, "");
  } catch {}

  // ── MCP Server ─────────────────────────────────────────────────────────
  const mcp = new Server(
    { name: serverName, version: opts.version ?? "1.0.0" },
    {
      capabilities: {
        experimental: { "claude/channel": {}, "claude/channel/permission": {} },
        tools: {},
      },
      instructions: [
        opts.agentName ? `Your agent name is "${opts.agentName}".` : "",
        architectInstructions || `Talon channel hub. Messages arrive as <channel source="${serverName}" chat_id="..." user="..." type="...">.\n`,
        "Message types: system (lifecycle), chat (conversations), tool_result (outputs).",
        "Use individual tools (reply, connect, send_message, call_tool, etc.) for actions.",
        opts.instructions ?? "",
      ].filter(Boolean).join("\n"),
    },
  );

  // ── Wire hub events → channel notifications ────────────────────────────
  // Gate: don't send notifications until MCP client has completed handshake
  let mcpReady = false;
  const pendingNotifications: Array<{ method: string; params: any }> = [];
  const flushPending = () => {
    if (mcpReady) return;
    mcpReady = true;
    process.stderr.write(`[${serverName}] MCP handshake complete — flushing ${pendingNotifications.length} buffered notifications\n`);
    for (const n of pendingNotifications) {
      mcp.notification({ method: n.method, params: n.params }).catch(() => {});
    }
    pendingNotifications.length = 0;
  };
  mcp.oninitialized = () => {
    if (mcpReady) {
      // Reconnect — send current status using same Ready:/Client: format
      const isClientOnly = hub.isClient();
      const prefix = isClientOnly ? "Client" : "Ready";
      const parts: string[] = [];
      if (!isClientOnly) {
        for (const [, srv] of (hub as any).servers ?? new Map()) {
          if (srv.type === "websocket") parts.push(`Server :${srv.port}`);
        }
      }
      for (const c of (hub.clients ? [...hub.clients.values()] : []) as any[]) {
        if (c.channel && c.channel !== "unix") parts.push(`${c.name ?? c.id} via ${c.channel}`);
      }
      const statusMsg = parts.length ? `${prefix}: ${parts.join(" · ")}` : `${prefix}: reconnected`;
      mcp.notification({
        method: "notifications/claude/channel",
        params: { content: statusMsg, meta: { user: "system", source: serverName, type: "system" } },
      }).catch(() => {});
      return;
    }
    flushPending();
  };
  // Fallback: flush after 3s in case client never sends notifications/initialized
  setTimeout(flushPending, 3000);
  const notify = (method: string, params: any) => {
    if (!mcpReady) {
      process.stderr.write(`[${serverName}] BUFFER notification (MCP not ready): ${method}\n`);
      pendingNotifications.push({ method, params });
      return;
    }
    mcp.notification({ method, params }).catch(() => {});
  };

  // Update Telegram bot commands when agents change
  const updateTelegramCommands = async () => {
    try {
      const settings = await hub.loadSettingsSafe();
      const token = (settings.transports?.telegram as any)?.botToken ?? HubConfigService.fromEnv().telegramBotToken();
      if (!token) return;
      const agents = [...hub.agents.values()];
      const commands = [
        { command: "status", description: "Hub status" },
        { command: "agents", description: "List connected agents" },
        { command: "help", description: "Available commands" },
        ...agents
          .filter(a => a.name !== serverName && !a.name.startsWith("agent-"))
          .map(a => ({ command: a.name, description: `Talk to ${a.name} agent` })),
      ];
      await fetch(`https://api.telegram.org/bot${token}/setMyCommands`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ commands: commands.slice(0, 100) }),
      });
    } catch {}
  };

  hub.on("agentConnected", ({ id, name, tools }) => {
    if (!initDone) {
      // Buffered into Ready summary — skip separate notification
      updateTelegramCommands();
      return;
    }
    notify("notifications/claude/channel", {
      content: `Agent "${name}" connected with tools: ${tools.map((t: any) => t.name).join(", ") || "none"}`,
      meta: { chat_id: id, user: name, source: serverName, type: "system" },
    });
    updateTelegramCommands();
  });

  hub.on("agentDisconnected", ({ id, name }) => {
    notify("notifications/claude/channel", {
      content: `Agent "${name}" disconnected`,
      meta: { chat_id: id, user: "system", source: serverName, type: "system" },
    });
    updateTelegramCommands();
  });

  // Cache maxInlineLength from settings (read once, not per message)
  let cachedMaxInline: number | null = null;
  hub.loadSettingsSafe().then(s => { cachedMaxInline = (s as any).maxInlineLength ?? 500; }).catch(() => { cachedMaxInline = 500; });

  // ── Task @mention and ~blocked-by routing ──
  hub.hook("onMessage", async ({ content, user }) => {
    if (!content) return;
    const cleanContent = content.replace(/[@~][\w-]+/g, "").trim();
    // @agent — notify on completion
    const atMentions = content.match(/@([\w-]+)/g);
    if (atMentions?.length) {
      for (const m of atMentions) {
        const target = m.slice(1);
        if (target !== user) hub.sendMessage(target, `[from ${user}] ${cleanContent}`);
      }
    }
    // ~agent — blocked-by: notify the blocker that someone is waiting
    const tildeRefs = content.match(/~([\w-]+)/g);
    if (tildeRefs?.length) {
      for (const m of tildeRefs) {
        const blocker = m.slice(1);
        if (blocker !== user) hub.sendMessage(blocker, `[waiting] ${user} is blocked by you: ${cleanContent}`);
      }
    }
  });

  hub.on("message", async ({ content, chatId, user, type, source, files }) => {
    const { writeFileSync } = await import("node:fs");
    const { join: joinPath } = await import("node:path");
    const { tmpdir } = await import("node:os");

    let displayContent = content ?? "";
    let fileInfo = "";

    // File attachments: save to /tmp
    if (files?.length) {
      for (const file of files) {
        if (file.data) {
          const path = joinPath(tmpdir(), `talon-recv-${Date.now()}-${file.name}`);
          writeFileSync(path, Buffer.from(file.data, "base64"));
          fileInfo += `\n[File saved: ${path}]`;
        }
      }
    }

    // Long text content: save to file, show preview
    const maxInline = cachedMaxInline ?? 500;
    if (displayContent.length > maxInline) {
      const path = joinPath(tmpdir(), `talon-msg-${Date.now()}.txt`);
      writeFileSync(path, displayContent);
      displayContent = displayContent.slice(0, 200) + `...\n[Full message: ${path}]`;
    }

    // Resolve chat_id to a readable name when possible
    const displayChatId = chatId ? (hub as any).displayName(chatId) : "unknown";

    // Format user identity as "source · name" when source differs from user
    const displayUser = (source && source !== "system" && source !== user && source !== serverName)
      ? `${source} · ${user ?? "unknown"}`
      : (user ?? "unknown");

    notify("notifications/claude/channel", {
      content: displayContent + fileInfo,
      meta: { chat_id: displayChatId, user: displayUser, source: source ?? serverName, type: type ?? "chat" },
    });
  });

  // Buffer init events, send as one combined notification after autoSetup
  const initParts: string[] = [];
  let initDone = false;

  hub.on("serverStarted", ({ port }) => {
    if (initDone) {
      notify("notifications/claude/channel", {
        content: `Server started on port ${port} (HTTP + WS)`,
        meta: { user: "system", source: serverName, type: "system" },
      });
    } else {
      initParts.push(`Server :${port}`);
    }
  });

  hub.on("connected", ({ url, transport, name }) => {
    if (initDone) {
      notify("notifications/claude/channel", {
        content: `Connected to ${url} via ${transport} as "${name}"`,
        meta: { user: "system", source: serverName, type: "system" },
      });
    } else {
      // For unix/ws connections to a hub daemon, show "hub" label instead of random agent ID
      const isHubConn = (transport === "unix" || transport === "websocket") && !url.startsWith("telegram://");
      initParts.push(isHubConn ? `hub via ${transport}` : `${name} via ${transport}`);
    }
  });

  hub.on("permissionVerdict", ({ request_id, behavior }) => {
    notify("notifications/claude/channel/permission", { request_id, behavior });
  });

  hub.on("approvalRequired", ({ code, name, address, tools }) => {
    notify("notifications/claude/channel", {
      content: `Agent "${name}" from ${address} requires approval. Pairing code: ${code}. Tools: ${tools.join(", ") || "none"}. Use "talon approve ${code}" or "talon deny ${code}".`,
      meta: { user: "system", source: serverName, type: "system" },
    });
  });

  hub.on("approvalPending", ({ message, url }) => {
    notify("notifications/claude/channel", {
      content: `Waiting for approval from ${url}. ${message ?? ""}`,
      meta: { user: "system", source: serverName, type: "system" },
    });
  });

  hub.on("approvalGranted", ({ agentId, url, info }) => {
    const agents: any[] = info?.agents ?? [];
    const remoteServerName: string = info?.server_name ?? url;
    const agentSummary = agents.length
      ? `Agents: ${agents.map((a: any) => a.name).join(", ")}`
      : "No agents connected";
    notify("notifications/claude/channel", {
      content: `Connected to hub "${remoteServerName}". ${agentSummary}.`,
      meta: { user: "system", source: serverName, type: "system" },
    });
  });

  hub.on("approvalDenied", ({ message, url }) => {
    notify("notifications/claude/channel", {
      content: `Connection denied by ${url}. ${message ?? ""}`,
      meta: { user: "system", source: serverName, type: "system" },
    });
  });

  // Health issues are logged to stderr; MCP notifications suppressed to avoid noise.

  hub.on("sendFailed", ({ error, target, type }) => {
    // Log to stderr (not MCP notification — avoid noisy channel messages to user)
    // But emit as hub message so agents can see delivery failures
    process.stderr.write(`[${serverName}] Send failed: ${error} (target: ${target ?? "unknown"}, type: ${type ?? "unknown"})\n`);
    hub.emit("message", { content: `Send failed: ${error}`, chatId: target ?? "system", user: "system", type: "system", source: serverName });
  });

  hub.on("handover", ({ chatId, toAgentId, toAgentName }) => {
    notify("notifications/claude/channel", {
      content: `Chat "${chatId}" handed over to agent "${toAgentName}" (${toAgentId})`,
      meta: { chat_id: chatId, user: "system", source: serverName, type: "system" },
    });
  });

  hub.on("updated", ({ from, to }: { from: string; to: string }) => {
    notify("notifications/claude/channel", {
      content: `SDK updated: ${from} -> ${to}`,
      meta: { user: "system", source: serverName, type: "system" },
    });
    // Notify client that tools may have changed
    notify("notifications/tools/list_changed", {});
  });

  hub.on("autoReload", () => {
    // After auto-reload (file watcher), notify client to re-fetch tools
    notify("notifications/tools/list_changed", {});
  });

  // ── Permission relay ───────────────────────────────────────────────────
  const PermReqSchema = z.object({
    method: z.literal("notifications/claude/channel/permission_request"),
    params: z.object({ request_id: z.string(), tool_name: z.string(), description: z.string(), input_preview: z.string() }),
  });
  mcp.setNotificationHandler(PermReqSchema, async ({ params }: any) => {
    for (const agent of hub.agents.values()) hub.wsSend(agent.ws, { type: "permission_request", request: params });
  });

  // ── Tool registry ───────────────────────────────────────────────────────
  const registry = new ToolRegistry({ hub, serverName, mcp });
  registerBuiltinTools(registry);

  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: registry.list(),
  }));

  mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;
    const result = await registry.handle(name, args);
    // registry.handle returns JSON string — wrap in MCP text content
    if (typeof result === "string") {
      return text(result);
    }
    return result;
  });

  // ── Dedup: prevent multiple server.js processes from the same plugin ────
  const pidFile = join(homedir(), ".talon", `architect-${hub.defaultPort}.pid`);
  try {
    const { readFileSync: rfs, writeFileSync: wfs, mkdirSync: mks } = await import("node:fs");
    const { createConnection } = await import("node:net");

    // Check if a hub server is already running — prefer Unix socket check (always present),
    // fall back to TCP (only present when HTTP transport is enabled).
    const socketPath = `/tmp/talon-${hub.defaultPort}.sock`;
    const { existsSync } = await import("node:fs");
    const socketInUse = existsSync(socketPath) && await new Promise<boolean>((resolve) => {
      const sock = createConnection({ path: socketPath }, () => { sock.destroy(); resolve(true); });
      sock.on("error", () => resolve(false));
      sock.setTimeout(500, () => { sock.destroy(); resolve(false); });
    });
    const portInUse = socketInUse || await new Promise<boolean>((resolve) => {
      const sock = createConnection({ port: hub.defaultPort, host: "127.0.0.1" }, () => {
        sock.destroy();
        resolve(true);
      });
      sock.on("error", () => resolve(false));
      sock.setTimeout(500, () => { sock.destroy(); resolve(false); });
    });

    if (portInUse) {
      // Hub is active — another architect is already serving; connect as client instead of killing it
      process.stderr.write(`[${serverName}] Hub already running (${socketInUse ? "unix socket" : "port"} ${hub.defaultPort}) — deferring to existing architect\n`);
    } else {
      // Port is free — check if old PID is stale and clean up
      try {
        const existingPid = parseInt(rfs(pidFile, "utf-8").trim(), 10);
        if (existingPid && existingPid !== process.pid) {
          let isAlive = false;
          try { process.kill(existingPid, 0); isAlive = true; } catch {}
          if (isAlive) {
            // Process exists but port is not in use — stale process, kill it
            try { process.kill(existingPid, "SIGKILL"); process.stderr.write(`[${serverName}] Killed stale architect (PID ${existingPid})\n`); await new Promise(r => setTimeout(r, 200)); } catch {}
          }
        }
      } catch {}
    }

    mks(join(homedir(), ".talon"), { recursive: true });
    wfs(pidFile, String(process.pid));
  } catch {}

  // ── Global error handlers — MCP server must never crash ────────────────
  process.on("uncaughtException", (err) => {
    process.stderr.write(`[${serverName}] uncaughtException (kept alive): ${err.stack ?? err}\n`);
  });
  process.on("unhandledRejection", (err) => {
    process.stderr.write(`[${serverName}] unhandledRejection (kept alive): ${err}\n`);
  });

  // ── Start ──────────────────────────────────────────────────────────────
  // Connect MCP transport FIRST — autoSetup event handlers emit notifications
  // via stdout, which corrupts the handshake if MCP isn't ready yet.
  await mcp.connect(new StdioServerTransport());

  // Exit when stdin closes (parent Claude process died) — prevents orphan daemons
  process.stdin.on("close", () => process.exit(0));

  // Now safe to start hub (notifications go through MCP transport properly)
  hub.autoSetup().then(() => {
    initDone = true;
    const isClientOnly = hub.isClient();
    if (initParts.length > 0) {
      const prefix = isClientOnly ? "Client" : "Ready";
      const full = initParts.join(" · ");
      const content = full.length > 120
        ? `${prefix}: ${initParts.length} connections (${initParts.slice(0, 3).join(", ")}${initParts.length > 3 ? `, +${initParts.length - 3} more` : ""})`
        : `${prefix}: ${full}`;
      notify("notifications/claude/channel", {
        content,
        meta: { user: "system", source: serverName, type: "system" },
      });
    } else if (isClientOnly) {
      notify("notifications/claude/channel", {
        content: `Client: connecting to port ${hub.defaultPort}…`,
        meta: { user: "system", source: serverName, type: "system" },
      });
    }
    process.stderr.write(`[${serverName}] Hub ready: ${initParts.join(", ") || "no connections"}\n`);
  }).catch((e) => {
    initDone = true;
    process.stderr.write(`[${serverName}] autoSetup failed: ${e}\n`);
  });

  return mcp;
}

// ── Lightweight agent MCP server ─────────────────────────────────────────
// Used by persistent agents launched via launch_agent. Connects to the hub
// via Unix socket only — no server, no health monitor, no file watcher,
// no Telegram, no auto-sync.  Minimal resource footprint.

export interface AgentMcpOptions {
  name?: string;
  version?: string;
  hubUrl?: string;
  port?: number;
}

export async function createAgentMcpServer(opts: AgentMcpOptions = {}): Promise<Server> {
  const { basename } = await import("node:path");
  const agentName = opts.name ?? HubConfigService.fromEnv().envAgentName ?? basename(process.cwd()) ?? "agent";
  const port = opts.port ?? 9090;
  const socketPath = `/tmp/talon-${port}.sock`;

  // Thin hub — no server, no auto-connect (no Telegram/channels), no auto-update
  // Build tool list for hub registration so the hub knows what this agent can do
  const toolNames = ["send", "reply", "status", "list_agents", "call_tool", "health"];
  const hub = new ChannelHub({
    name: agentName,
    port,
    autoStart: false,
    autoConnect: false,
    autoUpdate: false,
    clientTools: toolNames.map(name => ({ name, description: "", inputSchema: {} })),
  });

  // Connect to hub via Unix socket only (fast, local)
  try {
    await hub.connect(`unix://${socketPath}`, agentName);
    process.stderr.write(`[${agentName}] Connected to hub via ${socketPath}\n`);
  } catch (e) {
    process.stderr.write(`[${agentName}] Failed to connect to hub: ${e}\n`);
  }

  // MCP server — same tool surface as the full architect
  const mcp = new Server(
    { name: agentName, version: opts.version ?? "1.0.0" },
    {
      capabilities: {
        experimental: { "claude/channel": {} },
        tools: {},
      },
      instructions: `Agent "${agentName}" — connected to Talon hub via Unix socket. Use tools to communicate.`,
    },
  );

  // Wire hub messages → MCP channel notifications
  hub.on("message", async ({ content, chatId, user, type, source }) => {
    mcp.notification({ method: "notifications/claude/channel", params: {
      content,
      meta: { chat_id: chatId ?? "unknown", user: user ?? "unknown", source: source ?? agentName, type: type ?? "chat" },
    }}).catch(() => {});
  });

  // Tool registry — same tools as full architect
  const registry = new ToolRegistry({ hub, serverName: agentName, mcp });
  registerBuiltinTools(registry);

  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: registry.list(),
  }));

  mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;
    const result = await registry.handle(name, args);
    if (typeof result === "string") return text(result);
    return result;
  });

  // No autoSetup — just connect MCP transport
  await mcp.connect(new StdioServerTransport());
  process.stdin.on("close", () => process.exit(0));
  return mcp;
}
