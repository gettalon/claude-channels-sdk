/**
 * hub-server.ts — Unix socket + optional HTTP+WS server for ChannelHub.
 *
 * Default: Unix socket at /tmp/talon-{port}.sock (fast local IPC).
 * Optional: HTTP+WS on 0.0.0.0:{port} when settings.server.http is true
 *           or when the hub is started with { http: true }.
 *
 * Agent connections are handled identically regardless of transport.
 */
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer, type Server as NetServer, type Socket } from "node:net";
import { existsSync, unlinkSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { loadAgentConfig } from "./agent-config.js";
import type { ChannelHub } from "./hub.js";

const SOCKET_PATH = (port: number) => `/tmp/talon-${port}.sock`;

/** Install server methods onto the ChannelHub prototype. */
export function installServer(Hub: typeof ChannelHub): void {

  /**
   * Start the hub server.
   *
   * 1. Always creates a Unix socket at /tmp/talon-{port}.sock
   * 2. Optionally starts HTTP+WS on 0.0.0.0:{port} when:
   *    - settings.server?.http === true, OR
   *    - opts.http === true passed to startServer
   *
   * Returns { port, socketPath, http: boolean }.
   */
  Hub.prototype.startServer = async function(this: ChannelHub, port?: number, opts?: { http?: boolean; host?: string }): Promise<{ port: number }> {
    const p = port ?? this.defaultPort;
    if (this.servers.has(`unix:${p}`) || this.servers.has(`ws:${p}`)) return { port: p };

    // ── 1) Unix socket (always) ──────────────────────────────────────────
    const socketPath = SOCKET_PATH(p);
    const socketDir = dirname(socketPath);
    mkdirSync(socketDir, { recursive: true });
    if (existsSync(socketPath)) {
      // Check if another process owns the socket before unlinking
      const { createConnection } = await import("node:net");
      const socketAlive = await new Promise<boolean>((resolve) => {
        const sock = createConnection({ path: socketPath }, () => { sock.destroy(); resolve(true); });
        sock.on("error", () => resolve(false));
        setTimeout(() => { sock.destroy(); resolve(false); }, 1000);
      });
      if (socketAlive) {
        // Another healthy process owns this socket — don't unlink, connect as client instead
        throw Object.assign(new Error(`Unix socket ${socketPath} is active (another process owns it)`), { code: "EADDRINUSE" });
      }
      try { unlinkSync(socketPath); } catch {}
    }

    const unixServer: NetServer = createNetServer((socket: Socket) => {
      // Wrap raw socket in a WS-compatible interface for setupAgentConnection
      const wsLike = createWsFromSocket(socket);
      (this as any).setupAgentConnection(wsLike, "unix:local");
    });

    await new Promise<void>((resolve, reject) => {
      unixServer.on("error", reject);
      unixServer.listen(socketPath, resolve);
    });

    this.servers.set(`unix:${p}`, { type: "unix", port: p, httpServer: unixServer });
    process.stderr.write(`[${this.name}] Unix socket listening at ${socketPath}\n`);

    // ── 2) HTTP+WS ───────────────────────────────────────────────────────
    // Enabled when: opts.http === true, OR settings.servers has a ws/http entry for this port
    const settings = await this.loadSettings();
    const registeredServers: any[] = (settings as any).servers ?? [];
    const hasWsServer = registeredServers.some((s: any) => s.port === p && (s.type === "ws" || s.type === "http" || s.url?.startsWith("ws://") || s.url?.startsWith("http://")));
    const httpEnabled = opts?.http ?? hasWsServer;

    if (httpEnabled) {
      try {
        await (this as any).startHttpWs(p, opts?.host);
      } catch (e: any) {
        process.stderr.write(`[${this.name}] HTTP+WS on :${p} failed: ${e?.code ?? e}\n`);
      }
    }

    // Register server in settings (uses port as identifier regardless of transport)
    await this.registerServer(`unix://${socketPath}`, this.name, p);

    // Write daemon.pid so agent hubs can detect us via isDaemonListening()
    const daemonPidFile = join(homedir(), ".talon", "daemon.pid");
    try {
      mkdirSync(join(homedir(), ".talon"), { recursive: true });
      writeFileSync(daemonPidFile, String(process.pid));
    } catch {}

    // ── Cleanup ──────────────────────────────────────────────────────────
    const cleanup = async () => {
      try { unixServer.close(); } catch {}
      try { unlinkSync(socketPath); } catch {}
      try { unlinkSync(daemonPidFile); } catch {}
      await this.unregisterServer(p).catch(() => {});
    };
    // Guard against stacking signal handlers on repeated startServer calls
    if (!(this as any)._serverCleanupRegistered) {
      (this as any)._serverCleanupRegistered = true;
      process.on("SIGINT", cleanup);
      process.on("SIGTERM", cleanup);
      process.on("exit", () => { try { unlinkSync(socketPath); } catch {} try { unlinkSync(daemonPidFile); } catch {} this.unregisterServer(p).catch(() => {}); });
    }

    // Prune stale agents every 30s (only one timer per hub instance)
    if (!(this as any)._pruneTimer) {
      (this as any)._pruneTimer = setInterval(() => {
        const now = Date.now();
        for (const [id, a] of this.agents) {
          if (now - a.lastHeartbeat > 90000) { a.ws.close(); this.agents.delete(id); }
        }
      }, 30000);
    }

    // Evict expired seen msgIds every 60s
    if (!(this as any)._seenEvictTimer) {
      (this as any)._seenEvictTimer = setInterval(() => {
        this.evictSeenMessages();
      }, 60_000);
    }

    this.emit("serverStarted", { port: p, socketPath, http: httpEnabled });
    await this.fireHooks("onServerStart", { port: p, socketPath, http: httpEnabled });
    return { port: p };
  };

  /**
   * Start HTTP+WS listener on a port.
   * Can be called after initial Unix-only startup to add HTTP access.
   */
  (Hub.prototype as any).startHttpWs = async function(this: ChannelHub, p: number, host?: string): Promise<void> {
    if (this.servers.has(`ws:${p}`)) return;

    const { WebSocketServer } = await import("ws");
    const httpServer = createHttpServer((req, res) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", name: this.name, agents: this.agents.size, port: p }));
        return;
      }
      if (req.method === "GET" && req.url === "/agents") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify([...this.agents.values()].map((a) => ({ id: a.id, name: a.name, tools: a.tools.map((t: any) => t.name) }))));
        return;
      }
      if (req.method === "POST" && req.url === "/message") {
        let body = "";
        req.on("data", (c: Buffer) => { body += c; });
        req.on("end", () => { this.emit("message", { content: body, source: "http" }); res.writeHead(200); res.end("ok"); });
        return;
      }
      res.writeHead(404); res.end("not found");
    });

    const bindHost = host ?? (this as any).opts?.host ?? "127.0.0.1";
    await new Promise<void>((resolve, reject) => { httpServer.on("error", reject); httpServer.listen(p, bindHost, resolve); });
    const wss = new WebSocketServer({ server: httpServer });
    wss.on("connection", (ws: any, req: any) => (this as any).setupAgentConnection(ws, req.socket.remoteAddress ?? "unknown"));

    this.servers.set(`ws:${p}`, { type: "websocket", port: p, httpServer, wss });
    process.stderr.write(`[${this.name}] HTTP+WS listening on ${bindHost}:${p}\n`);

    await this.registerServer(`ws://${bindHost}:${p}`, this.name, p).catch(() => {});

    const cleanup = async () => { await this.unregisterServer(p).catch(() => {}); };
    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);
  };

  // ── Agent connection handler (shared by Unix + WS) ─────────────────────

  (Hub.prototype as any).setupAgentConnection = function(this: ChannelHub, ws: any, addr: string): void {
    const ref = { id: null as string | null };
    ws.on("message", async (data: Buffer | string) => {
      let msg: any; try { msg = JSON.parse(data.toString()); } catch { return; }

      // ── E2E decryption: unwrap encrypted messages before processing ──
      if (msg.type === "e2e" && msg.e2e) {
        const session = (this as any).getE2eSessionForWs(ws);
        if (session) {
          try {
            const decrypted = session.decrypt(msg.e2e);
            msg = typeof decrypted === "string" ? JSON.parse(decrypted) : decrypted;
          } catch (e: any) {
            process.stderr.write(`[${this.name}] E2E decrypt failed: ${e.message}\n`);
            return;
          }
        } else {
          process.stderr.write(`[${this.name}] Received e2e message but no session for this ws\n`);
          return;
        }
      }

      // ── Key exchange: agent sends its public key ──
      if (msg.type === "key_exchange" && msg.publicKey) {
        const agent = ref.id ? this.agents.get(ref.id) : undefined;
        if (agent) {
          try {
            const { E2eSession, loadOrCreateIdentity } = await import("./mesh.js");
            const { getTalonHome } = await import("./hub-settings.js");
            if (!(this as any)._identity) (this as any)._identity = await loadOrCreateIdentity(getTalonHome());
            this.peerKeys.set(agent.name, msg.publicKey);
            this.e2eSessions.set(agent.name, E2eSession.fromKeyExchange((this as any)._identity.privateKey, msg.publicKey, this.name));
            // Send our public key back
            ws.send(JSON.stringify({ type: "key_exchange", publicKey: (this as any)._identity.publicKey }));
            process.stderr.write(`[${this.name}] E2E session established with "${agent.name}"\n`);
          } catch (e: any) {
            process.stderr.write(`[${this.name}] Key exchange failed: ${e.message}\n`);
          }
        }
      }

      if (msg.type === "register") {
        const agentName: string = msg.agent_name;
        const tools: any[] = msg.tools ?? [];
        const metadata = msg.metadata;

        // Check approval requirement
        const settings = await this.loadSettings();
        const requireApproval = settings.access?.requireApproval !== false;

        if (requireApproval) {
          const allowlist = settings.access?.allowlist ?? [];
          // Normalize IPv6-mapped IPv4 addresses (e.g. ::ffff:172.18.0.1 → 172.18.0.1)
          const normalizedAddr = addr.replace(/^::ffff:/, "");
          // Local connections (same machine) are always trusted — they bypass approval
          const isLocal = (normalizedAddr === "127.0.0.1" || addr === "::1" || addr === "localhost" || addr === "unix:local") && !(settings.access as any)?.forceApprovalAll;
          const isAllowed = isLocal || allowlist.some((entry: string) => {
            // Exact match (try both raw and normalized addr)
            if (entry === agentName || entry === addr || entry === normalizedAddr) return true;
            // Wildcard/glob match: "172.18.*", "agent-*", etc.
            if (entry.includes("*")) {
              const pattern = new RegExp("^" + entry.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
              return pattern.test(agentName) || pattern.test(addr) || pattern.test(normalizedAddr);
            }
            // Prefix match: "unix:" matches all unix connections
            if (entry.endsWith(":") && addr.startsWith(entry)) return true;
            return false;
          });

          if (!isAllowed) {
            // Agent not in allowlist — hold in pending map
            const code = (this as any).generatePairingCode();
            this.pendingAgents.set(code, { code, name: agentName, address: addr, tools, ws, metadata, requestedAt: Date.now() });
            this.wsSend(ws, { type: "register_ack", status: "pending_approval", message: `Approval required. Pairing code: ${code}` });
            this.emit("approvalRequired", { code, name: agentName, address: addr, tools: tools.map((t: any) => t.name) });
            process.stderr.write(`[${this.name}] Agent "${agentName}" from ${addr} pending approval (code: ${code})\n`);
            return;
          }
        }

        // Agent is allowed (no approval needed, or in allowlist) — register normally
        (this as any).completeRegistration(ws, addr, agentName, tools, metadata, ref);
      }

      if (msg.type === "heartbeat") {
        if (ref.id && this.agents.has(ref.id)) this.agents.get(ref.id)!.lastHeartbeat = Date.now();
        this.wsSend(ws, { type: "heartbeat_ack" });
      }


      if (msg.type === "tool_result") {
        const p = this.pendingCalls.get(msg.call_id);
        if (p) { clearTimeout(p.timer); this.pendingCalls.delete(msg.call_id); p.resolve(msg.error ? { error: msg.error } : msg.result); }
      }

      if (msg.type === "chat" || msg.type === "reply") {
        // Flood deduplication: drop messages already seen by msgId
        if (msg.msgId && this.seenOrTrack(msg.msgId)) return;

        const fromName = msg.from ?? this.agents.get(ref.id!)?.name ?? "unknown";
        const chatId = msg.chat_id ?? ref.id ?? "unknown";
        const content = msg.content ?? msg.text ?? "";

        // If a specific target agent is named and no chatRoute applies, send directly
        if (msg.target && !this.chatRoutes.has(chatId)) {
          const target = this.findAgent(msg.target);
          if (target) {
            this.wsSend(target.ws, { type: "chat", chat_id: chatId, content, from: fromName, ...(msg.msgId ? { msgId: msg.msgId } : {}) });
            return;
          }
          // Target not found (hub itself or unknown) — fall through to routeChat so hub receives it
        }

        this.routeChat({ chatId, content, from: fromName, source: "agent", senderAgentId: ref.id ?? undefined });
      }

      if (msg.type === "permission_verdict") {
        this.emit("permissionVerdict", { request_id: msg.request_id, behavior: msg.behavior });
      }

      if (msg.type === "group_broadcast") {
        // Agent sends a group_broadcast — forward to all other members (any type)
        const sender = ref.id ? this.agents.get(ref.id) : undefined;
        const groupName = msg.meta?.group ?? sender?.groupName;
        if (sender && groupName) {
          this.broadcastToGroup(groupName, msg.content ?? "", sender.name);
        }
      }

      // Hub peer sends a group membership change — apply locally (no re-flood)
      if (msg.type === "group_sync") {
        const { op, groupName, member, receiveMode, memberId, memberName } = msg;
        if (op === "add" && groupName && member) {
          if (!this.groups.has(groupName)) this.groups.set(groupName, new Map());
          this.groups.get(groupName)!.set(member, {
            name: member,
            mode: (receiveMode === "@only" ? "@only" : "all") as "all" | "@only",
            agentId: memberId,
            agentName: memberName,
          });
          process.stderr.write(`[${this.name}] group_sync: "${member}" added to "${groupName}" (from peer)\n`);
          (this as any).notifyGroupJoin?.(groupName, member);
        } else if (op === "remove" && groupName && member) {
          const group = this.groups.get(groupName);
          if (group) {
            group.delete(member);
            process.stderr.write(`[${this.name}] group_sync: "${member}" removed from "${groupName}" (from peer)\n`);
          }
        }
      }

      // ── Agent-initiated release: return chat to host ──
      if (msg.type === "release") {
        const chatId = msg.chat_id;
        if (!chatId) {
          this.wsSend(ws, { type: "ack", ref: "release", status: "error", reason: "chat_id required" });
          return;
        }
        const routeOwner = this.chatRoutes.get(chatId);
        if (routeOwner !== ref.id) {
          this.wsSend(ws, { type: "ack", ref: "release", status: "error", reason: "You don't own this route" });
          return;
        }
        (this as any).clearRoute(chatId);
        const agentName = this.agents.get(ref.id!)?.name ?? ref.id;
        this.emit("chatReleased", { chatId, agentId: ref.id, agentName });
        process.stderr.write(`[${this.name}] Agent "${agentName}" released chat "${chatId}" back to host\n`);
        this.wsSend(ws, { type: "ack", ref: "release", status: "ok" });
      }

      // ── Agent-initiated handover: pass chat to another agent ──
      if (msg.type === "handover") {
        const chatId = msg.chat_id;
        const toAgent = msg.to_agent;
        if (!chatId || !toAgent) {
          this.wsSend(ws, { type: "ack", ref: "handover", status: "error", reason: "chat_id and to_agent required" });
          return;
        }
        const routeOwner = this.chatRoutes.get(chatId);
        if (routeOwner !== ref.id) {
          this.wsSend(ws, { type: "ack", ref: "handover", status: "error", reason: "You don't own this route" });
          return;
        }
        const target = this.findAgent(toAgent);
        if (!target) {
          this.wsSend(ws, { type: "ack", ref: "handover", status: "error", reason: "Target agent not found" });
          return;
        }
        // Check target agent is allowed on this channel
        const channelClient = this.channelForChat.get(chatId);
        if (channelClient && target.allowedChannels?.length) {
          if (!target.allowedChannels.includes(channelClient.transport)) {
            this.wsSend(ws, { type: "ack", ref: "handover", status: "error", reason: `Agent "${target.name}" not authorized for ${channelClient.transport} channel` });
            this.emit("channelDenied", { agentId: target.id, agentName: target.name, channel: channelClient.transport, action: "handover" });
            return;
          }
        }
        // Transfer the route
        this.chatRoutes.set(chatId, target.id);
        this.persistState().catch(() => {});
        const fromName = this.agents.get(ref.id!)?.name ?? ref.id;
        this.wsSend(target.ws, { type: "chat", chat_id: chatId, content: `[system] Chat handed over from "${fromName}". You now own this chat.`, from: "system", meta: { type: "system", handover: "true" } });
        this.emit("chatHandover", { chatId, fromAgentId: ref.id, fromAgentName: fromName, toAgentId: target.id, toAgentName: target.name });
        process.stderr.write(`[${this.name}] Agent "${fromName}" handed chat "${chatId}" to "${target.name}"\n`);
        this.wsSend(ws, { type: "ack", ref: "handover", status: "ok" });
      }

      if (msg.type === "invite") {
        // Agent invites another member to its group (any type: WS agent, persistent, channel)
        const targetName = msg.invite_code;
        const groupName = msg.group_name;
        if (targetName && groupName) {
          this.addToGroup(groupName, targetName);
          // Notify the invited member if it's a WS agent
          const targetAgent = this.findAgent(targetName);
          if (targetAgent) {
            this.wsSend(targetAgent.ws, { type: "group_info", group_name: groupName, members: (this as any).getGroupMembers(groupName) });
          }
        }
      }

      // ── Streaming: forward stream messages between agents ──
      if (msg.type === "stream_start" || msg.type === "stream_chunk" || msg.type === "stream_end") {
        // Emit on the hub so local listeners can observe
        this.emit("stream", msg);

        // If the message has a target, forward to that specific agent
        if (msg.target) {
          const target = this.findAgent(msg.target);
          if (target) {
            this.wsSend(target.ws, msg);
          }
        } else {
          // Broadcast to all other connected agents (excluding sender)
          for (const [agentId, agent] of this.agents) {
            if (agentId === ref.id) continue;
            this.wsSend(agent.ws, msg);
          }
        }
      }

      if (msg.type === "tool_call_proxy") {
        // Client is asking us (the server) to forward a tool_call to a target agent
        const target = this.findAgent(msg.target);
        if (!target) {
          this.wsSend(ws, { type: "tool_result", call_id: msg.call_id, error: "Agent not found" });
          return;
        }
        // Forward the tool_call to the target agent
        const proxyCallId = msg.call_id;
        const proxyTimer = setTimeout(() => {
          this.pendingCalls.delete(proxyCallId);
          this.wsSend(ws, { type: "tool_result", call_id: proxyCallId, error: "Timeout" });
        }, 60000);
        this.pendingCalls.set(proxyCallId, {
          resolve: (result: unknown) => { this.wsSend(ws, { type: "tool_result", call_id: proxyCallId, result }); },
          reject: (err: Error) => { this.wsSend(ws, { type: "tool_result", call_id: proxyCallId, error: err.message }); },
          timer: proxyTimer,
        });
        this.wsSend(target.ws, { type: "tool_call", call_id: proxyCallId, tool_name: msg.tool_name, args: msg.args });
      }

      // ── proxy_command: client delegates state operations to the server ──
      if (msg.type === "proxy_command") {
        const { proxy_id, command, args: cmdArgs } = msg;
        let result: unknown;
        let error: string | undefined;
        try {
          switch (command) {
            case "handover":
              result = this.handover(cmdArgs.chatId, cmdArgs.toAgentId);
              break;
            case "releaseChat":
              result = this.releaseChat(cmdArgs.chatId);
              break;
            case "getChatRoute":
              result = this.getChatRoute(cmdArgs.chatId);
              break;
            case "createGroup":
              result = this.createGroup(cmdArgs.name);
              break;
            case "addToGroup":
              result = this.addToGroup(cmdArgs.groupName, cmdArgs.agentId);
              break;
            case "removeFromGroup":
              result = this.removeFromGroup(cmdArgs.groupName, cmdArgs.agentId);
              break;
            case "deleteGroup":
              result = this.deleteGroup(cmdArgs.name);
              break;
            case "listGroups":
              result = this.listGroups();
              break;
            case "broadcastToGroup":
              result = this.broadcastToGroup(cmdArgs.groupName, cmdArgs.content, cmdArgs.from);
              break;
            case "listAgents":
              result = [...this.agents.values()].map((a: any) => ({
                id: a.id, name: a.name,
                tools: a.tools.map((t: any) => t.name),
                lastHeartbeat: a.lastHeartbeat,
              }));
              break;
            case "routeChat":
              this.routeChat(cmdArgs as any);
              result = { ok: true };
              break;
            case "getStatus":
              result = this.getStatus();
              break;
            case "getHealth":
              result = await this.getHealth();
              break;
            default:
              error = `Unknown proxy command: ${command}`;
          }
        } catch (e: any) {
          error = e.message ?? String(e);
        }
        this.wsSend(ws, { type: "proxy_result", proxy_id, result, error });
      }
    });

    ws.on("close", () => {
      if (ref.id) {
        // Only clean up if this ws is still the active one for this agent
        // (avoids race where a reconnecting agent replaces the ws before the old close fires)
        const current = this.agents.get(ref.id);
        if (!current || current.ws !== ws) return;

        (this as any).removeFromAllGroups(ref.id);
        for (const [chatId, agentId] of this.chatRoutes) {
          if (agentId === ref.id) this.clearRoute(chatId);
        }
        const name = current.name ?? ref.id;
        this.agents.delete(ref.id);
        // Clean up target registry entry for this agent
        if ((this as any).unregisterTarget) {
          (this as any).unregisterTarget(ref.id);
        } else {
          // Fallback: remove directly
          const entry = this.targetRegistry.get(ref.id);
          if (entry) {
            this.targetRegistry.delete(ref.id);
            if (this.targetNameIndex.get(entry.name) === ref.id) this.targetNameIndex.delete(entry.name);
          }
        }
        this.emit("agentDisconnected", { id: ref.id, name });
        this.fireHooks("onAgentDisconnect", { id: ref.id, name }).catch(() => {});
      }
      // Clean up from pending if the agent disconnects before approval
      for (const [code, pa] of this.pendingAgents) {
        if (pa.ws === ws) { this.pendingAgents.delete(code); break; }
      }
    });
  };

  /** Complete agent registration (shared by direct register and post-approval) */
  (Hub.prototype as any).completeRegistration = function(this: ChannelHub, ws: any, addr: string, agentName: string, tools: any[], metadata: any, ref: { id: string | null }): void {
    let id: string;
    let isReconnect = false;
    const existing = [...this.agents.entries()].find(([, a]) => a.name === agentName);
    if (existing) {
      id = existing[0];
      try { existing[1].ws.close(); } catch {}
      this.agents.set(id, { id, name: agentName, tools, ws, lastHeartbeat: Date.now(), address: addr, metadata, allowedChannels: metadata?.allowedChannels as string[] | undefined, intents: metadata?.intents as string[] | undefined });
      isReconnect = true;
    } else {
      id = (this as any).genId();
      this.agents.set(id, { id, name: agentName, tools, ws, lastHeartbeat: Date.now(), address: addr, metadata, allowedChannels: metadata?.allowedChannels as string[] | undefined, intents: metadata?.intents as string[] | undefined });
    }
    ref.id = id;

    // Auto-register in unified target registry
    if ((this as any).registerTarget) {
      (this as any).registerTarget(agentName, "agent", id, "agent");
    }

    // Auto-establish E2E session if agent provided publicKey in metadata
    const peerPublicKey = metadata?.publicKey as string | undefined;
    if (peerPublicKey) {
      (async () => {
        try {
          const { E2eSession, loadOrCreateIdentity } = await import("./mesh.js");
          const { getTalonHome } = await import("./hub-settings.js");
          if (!(this as any)._identity) (this as any)._identity = await loadOrCreateIdentity(getTalonHome());
          this.peerKeys.set(agentName, peerPublicKey);
          this.e2eSessions.set(agentName, E2eSession.fromKeyExchange((this as any)._identity.privateKey, peerPublicKey, this.name));
          // Send our public key so the agent can create its session too
          ws.send(JSON.stringify({ type: "key_exchange", publicKey: (this as any)._identity.publicKey }));
          process.stderr.write(`[${this.name}] E2E session auto-established with "${agentName}"\n`);
        } catch (e: any) {
          process.stderr.write(`[${this.name}] Auto key exchange failed: ${e.message}\n`);
        }
      })();
    }

    // Build discovery payload — only what this client is allowed to access.
    // The newly registered agent's own ACL (allowedAgents) determines what it can see.
    const newAgent = this.agents.get(id)!;
    const allowedAgentNames = new Set(newAgent.allowedAgents ?? []);
    const canSeeAll = allowedAgentNames.size === 0; // empty = no restriction

    // Filter agents: show those the client is allowed to contact (excludes self)
    // Always include the hub itself so remote clients have at least one addressable target
    const visibleAgents = [
      { id: "hub", name: this.name, tools: [] as string[] },
      ...[...this.agents.values()]
        .filter(a => a.id !== id)
        .filter(a => canSeeAll || allowedAgentNames.has(a.name) || allowedAgentNames.has(a.id))
        .map(a => ({ id: a.id, name: a.name, tools: a.tools?.map((t: any) => t.name) })),
    ];

    // Filter groups: show groups the client is a member of
    const visibleGroups = [...this.groups.entries()]
      .filter(([, members]) => canSeeAll || members.has(id) || members.has(agentName))
      .map(([name, members]) => ({ name, members: [...members.values()].map(m => m.name) }));

    // Filter chat routes: only routes owned by visible agents
    const visibleAgentIds = new Set(visibleAgents.map(a => a.id));
    const chatRoutes: Record<string, { agentName?: string }> = {};
    for (const [chatId, agentId] of this.chatRoutes) {
      if (visibleAgentIds.has(agentId)) {
        const agent = this.agents.get(agentId);
        chatRoutes[chatId] = { agentName: agent?.name };
      }
    }

    const discoveryInfo = {
      server_name: this.name,
      agents: visibleAgents,
      groups: visibleGroups,
      chat_routes: chatRoutes,
    };

    this.wsSend(ws, { type: "register_ack", agent_id: id, status: "ok", info: discoveryInfo });
    // Flush any messages buffered while this agent was offline
    this.flushBufferedMessages(agentName);
    if (!isReconnect) {
      this.emit("agentConnected", { id, name: agentName, tools });
      this.fireHooks("onAgentConnect", { id, name: agentName, tools }).catch(() => {});
    }
    // Load per-agent config if it exists (non-blocking)
    loadAgentConfig(id, (this as any).agentConfigDir).then((config: any) => {
      if (config) {
        process.stderr.write(`[${this.name}] Loaded per-agent config for ${agentName} (${id})\n`);
        // Apply allowedChannels from config
        if (config.allowedChannels?.length) {
          const agent = this.agents.get(id);
          if (agent) agent.allowedChannels = config.allowedChannels;
        }
        // Merge intents from per-agent config (union with metadata intents)
        if (config.intents?.length) {
          const agent = this.agents.get(id);
          if (agent) {
            const existing = new Set(agent.intents ?? []);
            for (const intent of config.intents) existing.add(intent);
            agent.intents = [...existing];
          }
        }
        // Restore chatRoutes from per-agent config
        if (config.state?.chatRoutes) {
          for (const [chatId, info] of Object.entries(config.state.chatRoutes)) {
            if (!this.chatRoutes.has(chatId)) {
              this.chatRoutes.set(chatId, id);
            }
          }
        }
      }
    }).catch(() => {});
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Wrap a raw net.Socket into a WS-compatible interface (on("message"), send, close).
 * Messages are newline-delimited JSON, same as the Unix transport.
 */
function createWsFromSocket(socket: Socket): any {
  const handlers: Record<string, Function[]> = {};
  let buffer = "";

  socket.on("data", (data) => {
    buffer += data.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop()!;
    for (const line of lines) {
      if (!line.trim()) continue;
      for (const fn of handlers["message"] ?? []) {
        fn(line);
      }
    }
  });

  socket.on("close", () => {
    for (const fn of handlers["close"] ?? []) fn();
  });

  socket.on("error", () => {
    for (const fn of handlers["close"] ?? []) fn();
  });

  return {
    on(event: string, fn: Function) {
      (handlers[event] ??= []).push(fn);
    },
    send(data: string) {
      if (!socket.destroyed) {
        socket.write(data + "\n");
      }
    },
    close() {
      socket.destroy();
    },
    readyState: 1,
  };
}
