/**
 * HubServerRuntime — Extracted server logic from hub-server.ts.
 *
 * All 4 server methods that were previously monkey-patched onto ChannelHub
 * via installServer() are now proper instance methods on this class.
 * The hub reference is passed via constructor (simple pass-through for now).
 *
 * Part of the architecture refactor: Step 2 — Extract HubServerRuntime.
 */
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { existsSync, unlinkSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
const SOCKET_PATH = (port) => `/tmp/talon-${port}.sock`;
export class HubServerRuntime {
    hub;
    constructor(hub) {
        this.hub = hub;
    }
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
    async startServer(port, opts) {
        const hub = this.hub;
        const p = port ?? hub.defaultPort;
        if (hub.servers.has(`unix:${p}`) || hub.servers.has(`ws:${p}`))
            return { port: p };
        // ── 1) Unix socket (always) ──────────────────────────────────────────
        const socketPath = SOCKET_PATH(p);
        const socketDir = dirname(socketPath);
        mkdirSync(socketDir, { recursive: true });
        if (existsSync(socketPath)) {
            // Check if another process owns the socket before unlinking
            const { createConnection } = await import("node:net");
            const socketAlive = await new Promise((resolve) => {
                const sock = createConnection({ path: socketPath }, () => { sock.destroy(); resolve(true); });
                sock.on("error", () => resolve(false));
                setTimeout(() => { sock.destroy(); resolve(false); }, 1000);
            });
            if (socketAlive) {
                // Another healthy process owns this socket — don't unlink, connect as client instead
                throw Object.assign(new Error(`Unix socket ${socketPath} is active (another process owns it)`), { code: "EADDRINUSE" });
            }
            try {
                unlinkSync(socketPath);
            }
            catch { }
        }
        const unixServer = createNetServer((socket) => {
            // Wrap raw socket in a WS-compatible interface for setupAgentConnection
            const wsLike = createWsFromSocket(socket);
            this.setupAgentConnection(wsLike, "unix:local");
        });
        await new Promise((resolve, reject) => {
            unixServer.on("error", reject);
            unixServer.listen(socketPath, resolve);
        });
        hub.servers.set(`unix:${p}`, { type: "unix", port: p, httpServer: unixServer });
        process.stderr.write(`[${hub.name}] Unix socket listening at ${socketPath}\n`);
        // ── 2) HTTP+WS ───────────────────────────────────────────────────────
        // Enabled when: opts.http === true, OR settings.servers has a ws/http entry for this port
        const settings = await hub.loadSettings();
        const registeredServers = settings.servers ?? [];
        const hasWsServer = registeredServers.some((s) => s.port === p && (s.type === "ws" || s.type === "http" || s.url?.startsWith("ws://") || s.url?.startsWith("http://")));
        const httpEnabled = opts?.http ?? hasWsServer;
        if (httpEnabled) {
            try {
                await this.startHttpWs(p);
            }
            catch (e) {
                process.stderr.write(`[${hub.name}] HTTP+WS on :${p} failed: ${e?.code ?? e}\n`);
            }
        }
        // Register server in settings (uses port as identifier regardless of transport)
        await hub.registerServer(`unix://${socketPath}`, hub.name, p);
        // Write daemon.pid so agent hubs can detect us via isDaemonListening()
        const daemonPidFile = join(homedir(), ".talon", "daemon.pid");
        try {
            mkdirSync(join(homedir(), ".talon"), { recursive: true });
            writeFileSync(daemonPidFile, String(process.pid));
        }
        catch { }
        // ── Cleanup ──────────────────────────────────────────────────────────
        const cleanup = async () => {
            try {
                unixServer.close();
            }
            catch { }
            try {
                unlinkSync(socketPath);
            }
            catch { }
            try {
                unlinkSync(daemonPidFile);
            }
            catch { }
            await hub.unregisterServer(p).catch(() => { });
        };
        // Guard against stacking signal handlers on repeated startServer calls
        if (!hub._serverCleanupRegistered) {
            hub._serverCleanupRegistered = true;
            process.on("SIGINT", () => cleanup().then(() => process.exit(0)));
            process.on("SIGTERM", () => cleanup().then(() => process.exit(0)));
            process.on("exit", () => { try {
                unlinkSync(socketPath);
            }
            catch { } try {
                unlinkSync(daemonPidFile);
            }
            catch { } hub.unregisterServer(p).catch(() => { }); });
        }
        // Prune stale agents every 30s (only one timer per hub instance)
        if (!hub._pruneTimer) {
            hub._pruneTimer = setInterval(() => {
                const now = Date.now();
                for (const [id, a] of hub.agents) {
                    if (now - a.lastHeartbeat > 90000) {
                        a.ws.close();
                        hub.unregisterAgent(id);
                    }
                }
            }, 30000).unref();
        }
        // Evict expired seen msgIds every 60s
        if (!hub._seenEvictTimer) {
            hub._seenEvictTimer = setInterval(() => {
                hub.evictSeenMessages();
            }, 60_000).unref();
        }
        hub.emit("serverStarted", { port: p, socketPath, http: httpEnabled });
        await hub.fireHooks("onServerStart", { port: p, socketPath, http: httpEnabled });
        return { port: p };
    }
    /**
     * Start HTTP+WS listener on a port.
     * Can be called after initial Unix-only startup to add HTTP access.
     */
    async startHttpWs(p) {
        const hub = this.hub;
        if (hub.servers.has(`ws:${p}`))
            return;
        const { WebSocketServer } = await import("ws");
        const settings = await hub.loadSettings();
        const networkCfg = settings.network ?? {};
        const bindHost = networkCfg.bindHost ?? hub.opts?.host ?? "127.0.0.1";
        const allowedOrigins = networkCfg.corsOrigins;
        const authToken = networkCfg.authToken;
        const setCorsHeaders = (req, res) => {
            const origin = req.headers["origin"];
            if (origin) {
                if (allowedOrigins && allowedOrigins.length > 0) {
                    // Only reflect origins explicitly listed in config
                    if (allowedOrigins.includes(origin)) {
                        res.setHeader("Access-Control-Allow-Origin", origin);
                        res.setHeader("Vary", "Origin");
                    }
                }
                else {
                    // Default: allow only localhost origins
                    const isLocalhost = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
                    if (isLocalhost) {
                        res.setHeader("Access-Control-Allow-Origin", origin);
                        res.setHeader("Vary", "Origin");
                    }
                }
            }
            res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
            res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
        };
        const checkAuth = (req, res) => {
            if (!authToken)
                return true;
            const authHeader = req.headers["authorization"];
            if (authHeader === `Bearer ${authToken}`)
                return true;
            res.writeHead(401, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Unauthorized" }));
            return false;
        };
        const httpServer = createHttpServer((req, res) => {
            setCorsHeaders(req, res);
            if (req.method === "OPTIONS") {
                res.writeHead(204);
                res.end();
                return;
            }
            if (req.method === "GET" && req.url === "/health") {
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ status: "ok", name: hub.name, agents: hub.agents.size, port: p }));
                return;
            }
            if (req.method === "GET" && req.url === "/agents") {
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify([...hub.agents.values()].map((a) => ({ id: a.id, name: a.name, tools: a.tools.map((t) => t.name) }))));
                return;
            }
            if (req.method === "POST" && req.url === "/message") {
                if (!checkAuth(req, res))
                    return;
                let body = "";
                req.on("data", (c) => { body += c; });
                req.on("end", () => { hub.emit("message", { content: body, source: "http" }); res.writeHead(200); res.end("ok"); });
                return;
            }
            res.writeHead(404);
            res.end("not found");
        });
        await new Promise((resolve, reject) => { httpServer.on("error", reject); httpServer.listen(p, bindHost, resolve); });
        const wss = new WebSocketServer({ server: httpServer });
        wss.on("connection", (ws, req) => this.setupAgentConnection(ws, req.socket.remoteAddress ?? "unknown"));
        hub.servers.set(`ws:${p}`, { type: "websocket", port: p, httpServer, wss });
        process.stderr.write(`[${hub.name}] HTTP+WS listening on ${bindHost}:${p}\n`);
        await hub.registerServer(`ws://${bindHost}:${p}`, hub.name, p).catch(() => { });
        const cleanup = async () => { await hub.unregisterServer(p).catch(() => { }); };
        process.on("SIGINT", cleanup);
        process.on("SIGTERM", cleanup);
    }
    // ── Agent connection handler (shared by Unix + WS) ─────────────────────
    setupAgentConnection(ws, addr) {
        const hub = this.hub;
        const ref = { id: null };
        ws.on("message", async (data) => {
            let msg;
            try {
                msg = JSON.parse(data.toString());
            }
            catch {
                return;
            }
            // ── E2E decryption: unwrap encrypted messages before processing ──
            if (msg.type === "e2e" && msg.e2e) {
                const session = hub.getE2eSessionForWs(ws);
                if (session) {
                    try {
                        const decrypted = session.decrypt(msg.e2e);
                        msg = typeof decrypted === "string" ? JSON.parse(decrypted) : decrypted;
                    }
                    catch (e) {
                        process.stderr.write(`[${hub.name}] E2E decrypt failed: ${e.message}\n`);
                        return;
                    }
                }
                else {
                    process.stderr.write(`[${hub.name}] Received e2e message but no session for this ws\n`);
                    return;
                }
            }
            // ── Key exchange: agent sends its public key ──
            if (msg.type === "key_exchange" && msg.publicKey) {
                const agent = ref.id ? hub.agents.get(ref.id) : undefined;
                if (agent) {
                    try {
                        const { E2eSession, loadOrCreateIdentity } = await import("./mesh-compat.js");
                        const { getTalonHome } = await import("./hub-settings.js");
                        if (!hub._identity)
                            hub._identity = await loadOrCreateIdentity(getTalonHome());
                        hub.peerKeys.set(agent.name, msg.publicKey);
                        hub.e2eSessions.set(agent.name, E2eSession.fromKeyExchange(hub._identity.privateKey, msg.publicKey, hub.name));
                        // Send our public key back
                        ws.send(JSON.stringify({ type: "key_exchange", publicKey: hub._identity.publicKey }));
                        process.stderr.write(`[${hub.name}] E2E session established with "${agent.name}"\n`);
                    }
                    catch (e) {
                        process.stderr.write(`[${hub.name}] Key exchange failed: ${e.message}\n`);
                    }
                }
            }
            if (msg.type === "register") {
                const agentName = msg.agent_name;
                const tools = msg.tools ?? [];
                const metadata = msg.metadata;
                // Check approval requirement
                const settings = await hub.loadSettings();
                const requireApproval = settings.access?.requireApproval !== false;
                if (requireApproval) {
                    const allowlist = settings.access?.allowlist ?? [];
                    // Normalize IPv6-mapped IPv4 addresses (e.g. ::ffff:172.18.0.1 → 172.18.0.1)
                    const normalizedAddr = addr.replace(/^::ffff:/, "");
                    // Local connections (same machine) are always trusted — they bypass approval
                    const isLocal = (normalizedAddr === "127.0.0.1" || addr === "::1" || addr === "localhost" || addr === "unix:local") && !settings.access?.forceApprovalAll;
                    const isAllowed = isLocal || allowlist.some((entry) => {
                        // Exact match (try both raw and normalized addr)
                        if (entry === agentName || entry === addr || entry === normalizedAddr)
                            return true;
                        // Wildcard/glob match: "172.18.*", "agent-*", etc.
                        if (entry.includes("*")) {
                            const pattern = new RegExp("^" + entry.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
                            return pattern.test(agentName) || pattern.test(addr) || pattern.test(normalizedAddr);
                        }
                        // Prefix match: "unix:" matches all unix connections
                        if (entry.endsWith(":") && addr.startsWith(entry))
                            return true;
                        return false;
                    });
                    if (!isAllowed) {
                        // Agent not in allowlist — hold in pending map
                        const code = hub.generatePairingCode();
                        hub.addPendingAgent(code, { code, name: agentName, address: addr, tools, ws, metadata, requestedAt: Date.now() });
                        hub.wsSend(ws, { type: "register_ack", status: "pending_approval", message: `Approval required. Pairing code: ${code}` });
                        hub.emit("approvalRequired", { code, name: agentName, address: addr, tools: tools.map((t) => t.name) });
                        process.stderr.write(`[${hub.name}] Agent "${agentName}" from ${addr} pending approval (code: ${code})\n`);
                        return;
                    }
                }
                // Agent is allowed (no approval needed, or in allowlist) — register normally
                this.completeRegistration(ws, addr, agentName, tools, metadata, ref);
            }
            if (msg.type === "heartbeat") {
                if (ref.id && hub.agents.has(ref.id))
                    hub.agents.get(ref.id).lastHeartbeat = Date.now();
                hub.wsSend(ws, { type: "heartbeat_ack" });
            }
            if (msg.type === "tool_result") {
                const p = hub.pendingCalls.get(msg.call_id);
                if (p) {
                    clearTimeout(p.timer);
                    hub.pendingCalls.delete(msg.call_id);
                    p.resolve(msg.error ? { error: msg.error } : msg.result);
                }
            }
            if (msg.type === "chat" || msg.type === "reply") {
                // Flood deduplication: drop messages already seen by msgId
                if (msg.msgId && hub.seenOrTrack(msg.msgId))
                    return;
                const fromName = msg.from ?? hub.agents.get(ref.id)?.name ?? "unknown";
                const chatId = msg.chat_id ?? ref.id ?? "unknown";
                const content = msg.content ?? msg.text ?? "";
                // If a specific target agent is named and no chatRoute applies, send directly
                if (msg.target && !hub.chatRoutes.has(chatId)) {
                    const target = hub.findAgent(msg.target);
                    if (target) {
                        hub.wsSend(target.ws, { type: "chat", chat_id: chatId, content, from: fromName, ...(msg.msgId ? { msgId: msg.msgId } : {}) });
                        return;
                    }
                    // Target not found (hub itself or unknown) — fall through to routeChat so hub receives it
                }
                hub.routeChat({ chatId, content, from: fromName, source: "agent", senderAgentId: ref.id ?? undefined });
            }
            if (msg.type === "permission_verdict") {
                hub.emit("permissionVerdict", { request_id: msg.request_id, behavior: msg.behavior });
            }
            if (msg.type === "group_broadcast") {
                // Agent sends a group_broadcast — forward to all other members (any type)
                const sender = ref.id ? hub.agents.get(ref.id) : undefined;
                const groupName = msg.meta?.group ?? sender?.groupName;
                if (sender && groupName) {
                    hub.broadcastToGroup(groupName, msg.content ?? "", sender.name);
                }
            }
            // Hub peer sends a group membership change — apply locally (no re-flood)
            if (msg.type === "group_sync") {
                const { op, groupName, member, receiveMode, memberId, memberName } = msg;
                if (op === "add" && groupName && member) {
                    if (!hub.groups.has(groupName))
                        hub.groups.set(groupName, new Map());
                    hub.groups.get(groupName).set(member, {
                        name: member,
                        mode: (receiveMode === "@only" ? "@only" : "all"),
                        agentId: memberId,
                        agentName: memberName,
                    });
                    process.stderr.write(`[${hub.name}] group_sync: "${member}" added to "${groupName}" (from peer)\n`);
                    hub.notifyGroupJoin?.(groupName, member);
                }
                else if (op === "remove" && groupName && member) {
                    const group = hub.groups.get(groupName);
                    if (group) {
                        group.delete(member);
                        process.stderr.write(`[${hub.name}] group_sync: "${member}" removed from "${groupName}" (from peer)\n`);
                    }
                }
            }
            // ── Agent-initiated release: return chat to host ──
            if (msg.type === "release") {
                const chatId = msg.chat_id;
                if (!chatId) {
                    hub.wsSend(ws, { type: "ack", ref: "release", status: "error", reason: "chat_id required" });
                    return;
                }
                const routeOwner = hub.chatRoutes.get(chatId);
                if (routeOwner !== ref.id) {
                    hub.wsSend(ws, { type: "ack", ref: "release", status: "error", reason: "You don't own this route" });
                    return;
                }
                hub.clearRoute(chatId);
                const agentName = hub.agents.get(ref.id)?.name ?? ref.id;
                hub.emit("chatReleased", { chatId, agentId: ref.id, agentName });
                process.stderr.write(`[${hub.name}] Agent "${agentName}" released chat "${chatId}" back to host\n`);
                hub.wsSend(ws, { type: "ack", ref: "release", status: "ok" });
            }
            // ── Agent-initiated handover: pass chat to another agent ──
            if (msg.type === "handover") {
                const chatId = msg.chat_id;
                const toAgent = msg.to_agent;
                if (!chatId || !toAgent) {
                    hub.wsSend(ws, { type: "ack", ref: "handover", status: "error", reason: "chat_id and to_agent required" });
                    return;
                }
                const routeOwner = hub.chatRoutes.get(chatId);
                if (routeOwner !== ref.id) {
                    hub.wsSend(ws, { type: "ack", ref: "handover", status: "error", reason: "You don't own this route" });
                    return;
                }
                const target = hub.findAgent(toAgent);
                if (!target) {
                    hub.wsSend(ws, { type: "ack", ref: "handover", status: "error", reason: "Target agent not found" });
                    return;
                }
                // Check target agent is allowed on this channel
                const channelClient = hub.channelForChat.get(chatId);
                if (channelClient && target.allowedChannels?.length) {
                    if (!target.allowedChannels.includes(channelClient.transport)) {
                        hub.wsSend(ws, { type: "ack", ref: "handover", status: "error", reason: `Agent "${target.name}" not authorized for ${channelClient.transport} channel` });
                        hub.emit("channelDenied", { agentId: target.id, agentName: target.name, channel: channelClient.transport, action: "handover" });
                        return;
                    }
                }
                // Transfer the route
                hub.claimChat(chatId, target.id);
                hub.persistState().catch(() => { });
                const fromName = hub.agents.get(ref.id)?.name ?? ref.id;
                hub.wsSend(target.ws, { type: "chat", chat_id: chatId, content: `[system] Chat handed over from "${fromName}". You now own this chat.`, from: "system", meta: { type: "system", handover: "true" } });
                hub.emit("chatHandover", { chatId, fromAgentId: ref.id, fromAgentName: fromName, toAgentId: target.id, toAgentName: target.name });
                process.stderr.write(`[${hub.name}] Agent "${fromName}" handed chat "${chatId}" to "${target.name}"\n`);
                hub.wsSend(ws, { type: "ack", ref: "handover", status: "ok" });
            }
            if (msg.type === "invite") {
                // Agent invites another member to its group (any type: WS agent, persistent, channel)
                const targetName = msg.invite_code;
                const groupName = msg.group_name;
                if (targetName && groupName) {
                    hub.addToGroup(groupName, targetName);
                    // Notify the invited member if it's a WS agent
                    const targetAgent = hub.findAgent(targetName);
                    if (targetAgent) {
                        hub.wsSend(targetAgent.ws, { type: "group_info", group_name: groupName, members: hub.getGroupMembers(groupName) });
                    }
                }
            }
            // ── Streaming: forward stream messages between agents ──
            if (msg.type === "stream_start" || msg.type === "stream_chunk" || msg.type === "stream_end") {
                // Emit on the hub so local listeners can observe
                hub.emit("stream", msg);
                // If the message has a target, forward to that specific agent
                if (msg.target) {
                    const target = hub.findAgent(msg.target);
                    if (target) {
                        hub.wsSend(target.ws, msg);
                    }
                }
                else {
                    // Broadcast to all other connected agents (excluding sender)
                    for (const [agentId, agent] of hub.agents) {
                        if (agentId === ref.id)
                            continue;
                        hub.wsSend(agent.ws, msg);
                    }
                }
            }
            if (msg.type === "tool_call_proxy") {
                // Client is asking us (the server) to forward a tool_call to a target agent
                const target = hub.findAgent(msg.target);
                if (!target) {
                    hub.wsSend(ws, { type: "tool_result", call_id: msg.call_id, error: "Agent not found" });
                    return;
                }
                // Forward the tool_call to the target agent
                const proxyCallId = msg.call_id;
                const proxyTimer = setTimeout(() => {
                    hub.pendingCalls.delete(proxyCallId);
                    hub.wsSend(ws, { type: "tool_result", call_id: proxyCallId, error: "Timeout" });
                }, 60000);
                hub.pendingCalls.set(proxyCallId, {
                    resolve: (result) => { hub.wsSend(ws, { type: "tool_result", call_id: proxyCallId, result }); },
                    reject: (err) => { hub.wsSend(ws, { type: "tool_result", call_id: proxyCallId, error: err.message }); },
                    timer: proxyTimer,
                });
                hub.wsSend(target.ws, { type: "tool_call", call_id: proxyCallId, tool_name: msg.tool_name, args: msg.args });
            }
            // ── proxy_command: client delegates state operations to the server ──
            if (msg.type === "proxy_command") {
                const { proxy_id, command, args: cmdArgs } = msg;
                let result;
                let error;
                try {
                    switch (command) {
                        case "handover":
                            result = hub.handover(cmdArgs.chatId, cmdArgs.toAgentId);
                            break;
                        case "releaseChat":
                            result = hub.releaseChat(cmdArgs.chatId);
                            break;
                        case "getChatRoute":
                            result = hub.getChatRoute(cmdArgs.chatId);
                            break;
                        case "createGroup":
                            result = hub.createGroup(cmdArgs.name);
                            break;
                        case "addToGroup":
                            result = hub.addToGroup(cmdArgs.groupName, cmdArgs.agentId);
                            break;
                        case "removeFromGroup":
                            result = hub.removeFromGroup(cmdArgs.groupName, cmdArgs.agentId);
                            break;
                        case "deleteGroup":
                            result = hub.deleteGroup(cmdArgs.name);
                            break;
                        case "listGroups":
                            result = hub.listGroups();
                            break;
                        case "broadcastToGroup":
                            result = hub.broadcastToGroup(cmdArgs.groupName, cmdArgs.content, cmdArgs.from);
                            break;
                        case "listAgents":
                            result = [...hub.agents.values()].map((a) => ({
                                id: a.id, name: a.name,
                                tools: a.tools.map((t) => t.name),
                                lastHeartbeat: a.lastHeartbeat,
                            }));
                            break;
                        case "routeChat":
                            hub.routeChat(cmdArgs);
                            result = { ok: true };
                            break;
                        case "getStatus":
                            result = hub.getStatus();
                            break;
                        case "getHealth":
                            result = await hub.getHealth();
                            break;
                        default:
                            error = `Unknown proxy command: ${command}`;
                    }
                }
                catch (e) {
                    error = e.message ?? String(e);
                }
                hub.wsSend(ws, { type: "proxy_result", proxy_id, result, error });
            }
        });
        ws.on("close", () => {
            if (ref.id) {
                // Only clean up if this ws is still the active one for this agent
                // (avoids race where a reconnecting agent replaces the ws before the old close fires)
                const current = hub.agents.get(ref.id);
                if (!current || current.ws !== ws)
                    return;
                hub.removeFromAllGroups(ref.id);
                for (const [chatId, agentId] of hub.chatRoutes) {
                    if (agentId === ref.id)
                        hub.clearRoute(chatId);
                }
                const name = current.name ?? ref.id;
                hub.unregisterAgent(ref.id);
                // Clean up target registry entry for this agent
                hub.unregisterTarget(ref.id);
                hub.emit("agentDisconnected", { id: ref.id, name });
                hub.fireHooks("onAgentDisconnect", { id: ref.id, name }).catch(() => { });
            }
            // Clean up from pending if the agent disconnects before approval
            for (const [code, pa] of hub.pendingAgents) {
                if (pa.ws === ws) {
                    hub.removePendingAgent(code);
                    break;
                }
            }
        });
    }
    /** Complete agent registration (shared by direct register and post-approval) */
    completeRegistration(ws, addr, agentName, tools, metadata, ref) {
        const hub = this.hub;
        let id;
        let isReconnect = false;
        const existing = [...hub.agents.entries()].find(([, a]) => a.name === agentName);
        if (existing) {
            id = existing[0];
            try {
                existing[1].ws.close();
            }
            catch { }
            hub.registerAgent(id, { id, name: agentName, tools, ws, lastHeartbeat: Date.now(), address: addr, metadata, allowedChannels: metadata?.allowedChannels, intents: metadata?.intents });
            isReconnect = true;
        }
        else {
            id = hub.genId();
            hub.registerAgent(id, { id, name: agentName, tools, ws, lastHeartbeat: Date.now(), address: addr, metadata, allowedChannels: metadata?.allowedChannels, intents: metadata?.intents });
        }
        ref.id = id;
        // Auto-register in unified target registry
        if (hub.registerTarget) {
            hub.registerTarget(agentName, "agent", id, "agent");
        }
        // Auto-establish E2E session if agent provided publicKey in metadata
        const peerPublicKey = metadata?.publicKey;
        if (peerPublicKey) {
            (async () => {
                try {
                    const { E2eSession, loadOrCreateIdentity } = await import("./mesh-compat.js");
                    const { getTalonHome } = await import("./hub-settings.js");
                    if (!hub._identity)
                        hub._identity = await loadOrCreateIdentity(getTalonHome());
                    hub.peerKeys.set(agentName, peerPublicKey);
                    hub.e2eSessions.set(agentName, E2eSession.fromKeyExchange(hub._identity.privateKey, peerPublicKey, hub.name));
                    // Send our public key so the agent can create its session too
                    ws.send(JSON.stringify({ type: "key_exchange", publicKey: hub._identity.publicKey }));
                    process.stderr.write(`[${hub.name}] E2E session auto-established with "${agentName}"\n`);
                }
                catch (e) {
                    process.stderr.write(`[${hub.name}] Auto key exchange failed: ${e.message}\n`);
                }
            })();
        }
        // Build discovery payload — only what this client is allowed to access.
        // The newly registered agent's own ACL (allowedAgents) determines what it can see.
        const newAgent = hub.agents.get(id);
        const allowedAgentNames = new Set(newAgent.allowedAgents ?? []);
        const canSeeAll = allowedAgentNames.size === 0; // empty = no restriction
        // Filter agents: show those the client is allowed to contact (excludes self)
        // Always include the hub itself so remote clients have at least one addressable target
        const visibleAgents = [
            { id: "hub", name: hub.name, tools: [] },
            ...[...hub.agents.values()]
                .filter((a) => a.id !== id)
                .filter((a) => canSeeAll || allowedAgentNames.has(a.name) || allowedAgentNames.has(a.id))
                .map((a) => ({ id: a.id, name: a.name, tools: a.tools?.map((t) => t.name) })),
        ];
        // Filter groups: show groups the client is a member of
        const visibleGroups = [...hub.groups.entries()]
            .filter(([, members]) => canSeeAll || members.has(id) || members.has(agentName))
            .map(([name, members]) => ({ name, members: [...members.values()].map((m) => m.name) }));
        // Filter chat routes: only routes owned by visible agents
        const visibleAgentIds = new Set(visibleAgents.map(a => a.id));
        const chatRoutes = {};
        for (const [chatId, agentId] of hub.chatRoutes) {
            if (visibleAgentIds.has(agentId)) {
                const agent = hub.agents.get(agentId);
                chatRoutes[chatId] = { agentName: agent?.name };
            }
        }
        const discoveryInfo = {
            server_name: hub.name,
            agents: visibleAgents,
            groups: visibleGroups,
            chat_routes: chatRoutes,
        };
        hub.wsSend(ws, { type: "register_ack", agent_id: id, status: "ok", info: discoveryInfo });
        // Flush any messages buffered while this agent was offline
        hub.flushBufferedMessages(agentName);
        if (!isReconnect) {
            hub.emit("agentConnected", { id, name: agentName, tools });
            hub.fireHooks("onAgentConnect", { id, name: agentName, tools }).catch(() => { });
        }
        // Load per-agent config if it exists (non-blocking)
        import("./agent-config-compat.js").then(({ loadAgentConfig }) => loadAgentConfig(id, hub.agentConfigDir).then((config) => {
            if (config) {
                process.stderr.write(`[${hub.name}] Loaded per-agent config for ${agentName} (${id})\n`);
                // Apply allowedChannels from config
                if (config.allowedChannels?.length) {
                    const agent = hub.agents.get(id);
                    if (agent)
                        agent.allowedChannels = config.allowedChannels;
                }
                // Merge intents from per-agent config (union with metadata intents)
                if (config.intents?.length) {
                    const agent = hub.agents.get(id);
                    if (agent) {
                        const existing = new Set(agent.intents ?? []);
                        for (const intent of config.intents)
                            existing.add(intent);
                        agent.intents = [...existing];
                    }
                }
                // Restore chatRoutes from per-agent config
                if (config.state?.chatRoutes) {
                    for (const [chatId, info] of Object.entries(config.state.chatRoutes)) {
                        if (!hub.chatRoutes.has(chatId)) {
                            hub.claimChat(chatId, id);
                        }
                    }
                }
            }
        }).catch(() => { })).catch(() => { });
    }
}
// ── Helpers ────────────────────────────────────────────────────────────────
/**
 * Wrap a raw net.Socket into a WS-compatible interface (on("message"), send, close).
 * Messages are newline-delimited JSON, same as the Unix transport.
 */
function createWsFromSocket(socket) {
    const handlers = {};
    let buffer = "";
    socket.on("data", (data) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop();
        for (const line of lines) {
            if (!line.trim())
                continue;
            for (const fn of handlers["message"] ?? []) {
                fn(line);
            }
        }
    });
    socket.on("close", () => {
        for (const fn of handlers["close"] ?? [])
            fn();
    });
    socket.on("error", () => {
        for (const fn of handlers["close"] ?? [])
            fn();
    });
    return {
        on(event, fn) {
            (handlers[event] ??= []).push(fn);
        },
        send(data) {
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
//# sourceMappingURL=hub-server-runtime.js.map