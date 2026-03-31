/**
 * WebSocket Channel Adapter
 *
 * Accepts WebSocket connections from edge agents or remote Talon clients.
 * Features:
 * - Server mode: listens for incoming WS connections (edge agents call home)
 * - Client mode: connects to a remote WS server (Talon host)
 * - Agent registration: connected agents register their tools
 * - Tool routing: forward tool calls to connected agents, return results
 * - Binary transfer: images, files via WS binary frames
 * - Heartbeat / auto-reconnect
 * - Authentication via pairing tokens
 * - Multi-agent: multiple edge agents on one server
 */
import { ChannelServer } from "../channel-server.js";
// ── Parse Config ───────────────────────────────────────────────────────────────
export function parseConfig() {
    const mode = (process.env.WS_MODE ?? "both");
    // Parse group config from env
    let group;
    if (process.env.WS_GROUP_NAME) {
        group = {
            name: process.env.WS_GROUP_NAME,
            access: (process.env.WS_GROUP_ACCESS ?? "private"),
            peers: process.env.WS_GROUP_PEERS?.split(",").map((s) => s.trim()).filter(Boolean),
        };
    }
    return {
        mode,
        port: parseInt(process.env.WS_PORT ?? "8080", 10),
        host: process.env.WS_HOST ?? "0.0.0.0",
        url: process.env.WS_URL,
        agentName: process.env.WS_AGENT_NAME ?? `agent-${process.pid}`,
        pairToken: process.env.WS_PAIR_TOKEN,
        heartbeatInterval: parseInt(process.env.WS_HEARTBEAT_INTERVAL ?? "30000", 10),
        autoReconnect: process.env.WS_AUTO_RECONNECT !== "false",
        tools: [],
        group,
        httpEnabled: process.env.WS_HTTP !== "false",
    };
}
// ── Extra MCP Tools ────────────────────────────────────────────────────────────
const EXTRA_TOOLS = [
    {
        name: "ws_list_agents",
        description: "List all connected WebSocket agents and their tools",
        inputSchema: { type: "object", properties: {}, required: [] },
    },
    {
        name: "ws_call_tool",
        description: "Call a tool on a remote agent via WebSocket",
        inputSchema: {
            type: "object",
            properties: {
                agent_id: { type: "string", description: "ID of the remote agent" },
                tool_name: { type: "string", description: "Name of the tool to call" },
                args: { type: "object", description: "Arguments for the tool" },
            },
            required: ["agent_id", "tool_name"],
        },
    },
    {
        name: "ws_send_message",
        description: "Send a chat message to a connected agent",
        inputSchema: {
            type: "object",
            properties: {
                agent_id: { type: "string", description: "ID of the target agent" },
                content: { type: "string", description: "Message content" },
            },
            required: ["agent_id", "content"],
        },
    },
    {
        name: "ws_broadcast",
        description: "Broadcast a message to all agents in the group",
        inputSchema: {
            type: "object",
            properties: {
                content: { type: "string", description: "Message to broadcast" },
                group_name: { type: "string", description: "Group name (optional, broadcasts to all if omitted)" },
            },
            required: ["content"],
        },
    },
    {
        name: "ws_group_info",
        description: "Get group info: members, access mode, and pending approvals",
        inputSchema: {
            type: "object",
            properties: {
                group_name: { type: "string", description: "Group name (optional)" },
            },
        },
    },
    {
        name: "ws_group_approve",
        description: "Approve a pending agent by pairing code (private group)",
        inputSchema: {
            type: "object",
            properties: {
                code: { type: "string", description: "The pairing code to approve" },
            },
            required: ["code"],
        },
    },
    {
        name: "ws_group_invite",
        description: "Generate an invite. type='private' = one-time + expires, type='public' = reusable link",
        inputSchema: {
            type: "object",
            properties: {
                type: { type: "string", enum: ["private", "public"], description: "Invite type (default: private)" },
                label: { type: "string", description: "Optional label (e.g. agent name or purpose)" },
                ttl_minutes: { type: "number", description: "Expiry in minutes (default: 60, ignored for public)" },
                max_uses: { type: "number", description: "Max uses (default: 1 for private, unlimited for public)" },
            },
        },
    },
    {
        name: "ws_switch_mode",
        description: "Switch WebSocket mode at runtime: start/stop server or client connections",
        inputSchema: {
            type: "object",
            properties: {
                mode: { type: "string", enum: ["server", "client", "both"], description: "Target mode" },
                url: { type: "string", description: "URL to connect to (required when switching to client/both)" },
            },
            required: ["mode"],
        },
    },
];
// ── Create Channel ─────────────────────────────────────────────────────────────
export async function createWebSocketChannel(config) {
    const cfg = { ...parseConfig(), ...config };
    const group = cfg.group;
    const meshCfg = cfg.mesh;
    const isServer = cfg.mode === "server" || cfg.mode === "both";
    const isClient = cfg.mode === "client" || cfg.mode === "both";
    const agents = new Map();
    const pendingCalls = new Map();
    let callIdCounter = 0;
    // ── Mesh: JWT auth + E2E encryption + mDNS discovery ────────────────────────
    let meshDiscovery = null;
    let meshRegistry = null;
    let e2eSession = null;
    let meshVerifyJwt = null;
    let meshCreateJwt = null;
    if (meshCfg) {
        const meshMod = await import("../mesh.js");
        meshVerifyJwt = (token) => meshMod.verifyMeshJwt(token, meshCfg.meshSecret);
        meshCreateJwt = (deviceId) => meshMod.createMeshJwt(meshCfg.meshSecret, deviceId);
        if (meshCfg.e2e) {
            e2eSession = meshMod.E2eSession.fromMeshSecret(meshCfg.meshSecret, meshCfg.deviceId ?? `agent-${process.pid}`);
            process.stderr.write(`[ws-channel] E2E encryption enabled (AES-256-GCM)\n`);
        }
        if (meshCfg.mdns !== false) {
            meshDiscovery = new meshMod.MeshDiscovery(meshCfg);
        }
        if (meshCfg.registryUrl) {
            meshRegistry = new meshMod.MeshRegistry(meshCfg.meshSecret, meshCfg.deviceId ?? `agent-${process.pid}`, meshCfg.registryUrl);
        }
        process.stderr.write(`[ws-channel] Mesh enabled (id: ${meshMod.deriveMeshId(meshCfg.meshSecret).slice(0, 12)}...)\n`);
    }
    // ── Group: pending approvals + invites ───────────────────────────────────────
    const pendingGroupApprovals = new Map();
    const groupInvites = new Map();
    function generatePairingCode(length = 6) {
        const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
        let code = "";
        for (let i = 0; i < length; i++)
            code += chars[Math.floor(Math.random() * chars.length)];
        return code;
    }
    function isGroupFull() {
        if (!group?.maxMembers || group.maxMembers <= 0)
            return false;
        const memberCount = Array.from(agents.values()).filter((a) => a.groupName === group?.name).length;
        return memberCount >= group.maxMembers;
    }
    function validateInvite(code) {
        const invite = groupInvites.get(code);
        if (!invite)
            return null;
        // Check expiry (0 = never expires)
        if (invite.expiresAt > 0 && Date.now() > invite.expiresAt) {
            groupInvites.delete(code);
            return null;
        }
        // Check max uses (0 = unlimited)
        if (invite.maxUses > 0 && invite.uses >= invite.maxUses) {
            groupInvites.delete(code);
            return null;
        }
        return invite;
    }
    function consumeInvite(code) {
        const invite = groupInvites.get(code);
        if (!invite)
            return;
        invite.uses++;
        // Remove one-time private invites after use
        if (invite.type === "private" && invite.maxUses > 0 && invite.uses >= invite.maxUses) {
            groupInvites.delete(code);
        }
    }
    const instructions = [
        `Messages from WebSocket agents arrive as <channel source="websocket" chat_id="..." user="...">`,
        `Reply with the reply tool, passing chat_id back.`,
        `Use ws_list_agents to see connected agents and their tools.`,
        `Use ws_call_tool to execute a tool on a remote agent.`,
    ];
    if (group) {
        instructions.push(`Use ws_broadcast to send a message to all group members.`);
        instructions.push(`Use ws_group_info to see group members and status.`);
        if (group.access === "private") {
            instructions.push(`This is a PRIVATE group "${group.name}". New agents need approval via ws_group_approve, or use ws_group_invite to create invite links.`);
        }
        else if (group.access === "invite") {
            instructions.push(`This is an INVITE-ONLY group "${group.name}". Use ws_group_invite to create invite links (private=one-time, public=reusable).`);
        }
        else {
            instructions.push(`This is a PUBLIC group "${group.name}". Any agent can join freely.`);
        }
        if (group.maxMembers && group.maxMembers > 0) {
            instructions.push(`Max members: ${group.maxMembers}.`);
        }
    }
    if (meshCfg) {
        instructions.push(`Mesh networking active. Peers discovered via ${meshCfg.mdns !== false ? "mDNS + " : ""}${meshCfg.registryUrl ? "registry" : "manual config"}.`);
        if (meshCfg.e2e)
            instructions.push(`E2E encryption enabled (AES-256-GCM).`);
    }
    const channel = new ChannelServer({
        name: "websocket-channel",
        version: "1.2.0",
        instructions: instructions.join("\n"),
        extraTools: EXTRA_TOOLS,
    });
    // ── Send Helpers (with optional E2E encryption) ────────────────────────────
    function wsSend(ws, data) {
        try {
            const payload = e2eSession
                ? { type: "e2e", e2e: e2eSession.encrypt(data) }
                : data;
            ws.send(JSON.stringify(payload));
        }
        catch (err) {
            process.stderr.write(`[ws-channel] Send error: ${err}\n`);
        }
    }
    function genAgentId() {
        return `agent-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    }
    function broadcastToGroup(from, content, meta, targetGroup) {
        for (const agent of agents.values()) {
            if (agent.id === from)
                continue; // don't echo back
            if (targetGroup && agent.groupName !== targetGroup)
                continue;
            wsSend(agent.ws, { type: "group_broadcast", from, content, meta });
        }
    }
    function registerAgent(ws, msg, agentIdRef, isPeer = false) {
        const agentId = genAgentId();
        agentIdRef.id = agentId;
        const agent = {
            id: agentId,
            name: msg.agent_name,
            tools: msg.tools ?? [],
            ws,
            lastHeartbeat: Date.now(),
            metadata: msg.metadata,
            groupName: msg.group_name ?? group?.name,
            isPeer,
        };
        agents.set(agentId, agent);
        // Send mesh_secret + relay_url upon successful join so agent can derive JWT + E2E key
        wsSend(ws, {
            type: "register_ack",
            agent_id: agentId,
            status: "ok",
            mesh_secret: meshCfg?.meshSecret,
            relay_url: meshCfg?.registryUrl,
        });
        process.stderr.write(`[ws-channel] Agent registered: ${msg.agent_name} (${agentId}) with ${agent.tools.length} tools${agent.groupName ? ` [group: ${agent.groupName}]` : ""}\n`);
        // Notify Claude
        channel.pushMessage(`Agent "${msg.agent_name}" connected with tools: ${agent.tools.map((t) => t.name).join(", ") || "none"}${agent.groupName ? ` (group: ${agent.groupName})` : ""}`, { chat_id: agentId, user: msg.agent_name, source: "websocket" }).catch(() => { });
        // Send group info to the new agent
        if (agent.groupName) {
            const members = Array.from(agents.values())
                .filter((a) => a.groupName === agent.groupName)
                .map((a) => ({ id: a.id, name: a.name, tools: a.tools.map((t) => t.name) }));
            wsSend(ws, { type: "group_info", group_name: agent.groupName, members });
        }
    }
    // ── Message Handler ────────────────────────────────────────────────────────
    function handleWsMessage(ws, raw, agentIdRef) {
        let msg;
        try {
            msg = JSON.parse(raw);
        }
        catch {
            process.stderr.write(`[ws-channel] Invalid JSON message\n`);
            return;
        }
        switch (msg.type) {
            case "register": {
                // ── Max members check ──
                if (group && isGroupFull()) {
                    wsSend(ws, { type: "register_ack", agent_id: "", status: "denied", reason: `Group "${group.name}" is full (max ${group.maxMembers})` });
                    ws.close(4001, "Group full");
                    return;
                }
                // ── Auth: mesh JWT > invite code > legacy pair_token > open ──
                let authenticated = false;
                // 1. Mesh JWT (approved agents reconnecting)
                if (meshVerifyJwt && msg.pair_token) {
                    if (meshVerifyJwt(msg.pair_token))
                        authenticated = true;
                }
                // 2. Invite code (private or public link)
                if (!authenticated && msg.invite_code) {
                    const invite = validateInvite(msg.invite_code);
                    if (invite) {
                        consumeInvite(msg.invite_code);
                        authenticated = true;
                        process.stderr.write(`[ws-channel] Agent "${msg.agent_name}" joined via ${invite.type} invite (${invite.code})\n`);
                    }
                    else {
                        wsSend(ws, { type: "register_ack", agent_id: "", status: "denied", reason: "Invalid or expired invite code" });
                        return;
                    }
                }
                // 3. Legacy pair_token
                if (!authenticated && cfg.pairToken) {
                    if (msg.pair_token === cfg.pairToken) {
                        authenticated = true;
                    }
                    else if (!meshVerifyJwt) {
                        wsSend(ws, { type: "register_ack", agent_id: "", status: "denied", reason: "Invalid token" });
                        ws.close(4001, "Unauthorized");
                        return;
                    }
                }
                // 4. No auth configured = open
                if (!authenticated && !cfg.pairToken && !meshVerifyJwt && !group) {
                    authenticated = true;
                }
                // ── Group access control ──
                if (group && !authenticated) {
                    if (group.access === "public") {
                        // Public: anyone can join
                        authenticated = true;
                    }
                    else if (group.access === "private") {
                        // Private: need approval — generate pairing code
                        const code = generatePairingCode();
                        pendingGroupApprovals.set(code, {
                            ws, agentName: msg.agent_name, tools: msg.tools ?? [], metadata: msg.metadata, code,
                        });
                        wsSend(ws, { type: "register_ack", agent_id: "", status: "pending_approval", reason: `Private group "${group.name}" requires approval`, pairing_code: code });
                        process.stderr.write(`[ws-channel] Agent "${msg.agent_name}" pending approval for "${group.name}" (code: ${code})\n`);
                        channel.pushMessage(`Agent "${msg.agent_name}" requesting to join private group "${group.name}". Code: ${code}. Use ws_group_approve.`, { chat_id: "system", user: "system", source: "websocket" }).catch(() => { });
                        return;
                    }
                    else if (group.access === "invite") {
                        // Invite-only: must have a valid invite code (already checked above)
                        wsSend(ws, { type: "register_ack", agent_id: "", status: "denied", reason: `Group "${group.name}" is invite-only. Provide an invite code.` });
                        return;
                    }
                }
                registerAgent(ws, msg, agentIdRef);
                break;
            }
            case "heartbeat": {
                if (agentIdRef.id) {
                    const agent = agents.get(agentIdRef.id);
                    if (agent)
                        agent.lastHeartbeat = Date.now();
                }
                wsSend(ws, { type: "heartbeat_ack" });
                break;
            }
            case "tool_result": {
                const pending = pendingCalls.get(msg.call_id);
                if (pending) {
                    clearTimeout(pending.timer);
                    pendingCalls.delete(msg.call_id);
                    if (msg.error) {
                        pending.resolve(JSON.stringify({ error: msg.error }));
                    }
                    else {
                        pending.resolve(typeof msg.result === "string" ? msg.result : JSON.stringify(msg.result));
                    }
                }
                break;
            }
            case "tool_call": {
                // Host calling a tool on this agent (client mode)
                const toolCb = channel.toolHandler;
                if (toolCb) {
                    (async () => {
                        try {
                            const result = await toolCb(msg.tool_name, msg.args);
                            const text = typeof result === "string" ? result : JSON.stringify(result);
                            wsSend(ws, { type: "tool_result", call_id: msg.call_id, result: text });
                        }
                        catch (err) {
                            wsSend(ws, { type: "tool_result", call_id: msg.call_id, error: String(err) });
                        }
                    })();
                }
                else {
                    wsSend(ws, { type: "tool_result", call_id: msg.call_id, error: "No tool handler registered" });
                }
                break;
            }
            case "chat": {
                // Agent sending a message to Claude
                channel.pushMessage(msg.content, {
                    chat_id: msg.chat_id ?? agentIdRef.id ?? "unknown",
                    user: agents.get(agentIdRef.id ?? "")?.name ?? "unknown",
                    source: "websocket",
                    ...(msg.meta ?? {}),
                }).catch(() => { });
                break;
            }
            case "reply": {
                // Host sending a reply to this agent — push into Claude session
                channel.pushMessage(msg.text, {
                    chat_id: msg.chat_id ?? "host",
                    user: "host",
                    source: "websocket",
                }).catch(() => { });
                channel.emit("reply", msg.chat_id, msg.text);
                break;
            }
            case "permission_verdict": {
                channel.sendPermissionVerdict({
                    request_id: msg.request_id,
                    behavior: msg.behavior,
                }).catch(() => { });
                break;
            }
            case "file_transfer": {
                const pending2 = pendingCalls.get(msg.call_id);
                if (pending2) {
                    clearTimeout(pending2.timer);
                    pendingCalls.delete(msg.call_id);
                    pending2.resolve(JSON.stringify({
                        filename: msg.filename,
                        mime: msg.mime,
                        size: msg.data.length,
                        data_base64: msg.data,
                    }));
                }
                break;
            }
            case "group_broadcast": {
                // Relay broadcast from one agent to all others in the group
                const senderAgent = agents.get(agentIdRef.id ?? "");
                const groupName = senderAgent?.groupName;
                for (const agent of agents.values()) {
                    if (agent.id === agentIdRef.id)
                        continue;
                    if (groupName && agent.groupName !== groupName)
                        continue;
                    wsSend(agent.ws, msg);
                }
                // Also push to Claude
                channel.pushMessage(msg.content, {
                    chat_id: agentIdRef.id ?? "unknown",
                    user: senderAgent?.name ?? msg.from,
                    source: "websocket",
                    broadcast: "true",
                    ...(msg.meta ?? {}),
                }).catch(() => { });
                break;
            }
        }
    }
    // ── Reply Handler ──────────────────────────────────────────────────────────
    channel.onReply((chatId, text) => {
        const agent = agents.get(chatId);
        if (agent) {
            wsSend(agent.ws, { type: "reply", chat_id: chatId, text });
        }
    });
    // ── Permission Handler ─────────────────────────────────────────────────────
    channel.onPermissionRequest((request) => {
        for (const agent of agents.values()) {
            wsSend(agent.ws, { type: "permission_request", request });
        }
    });
    // ── Runtime state ───────────────────────────────────────────────────────────
    let currentMode = cfg.mode;
    let wss = null;
    const peerClients = [];
    const heartbeatTimers = [];
    const reconnectTimers = [];
    let serverRunning = false;
    let clientUrl = cfg.url;
    let httpServer = null;
    // ── Shared helpers ─────────────────────────────────────────────────────────
    function setupServerConnection(ws, addr) {
        process.stderr.write(`[ws-channel] New connection from ${addr}\n`);
        const agentIdRef = { id: null };
        ws.on("message", (data) => {
            handleWsMessage(ws, data.toString(), agentIdRef);
        });
        ws.on("close", () => {
            if (agentIdRef.id) {
                const agent = agents.get(agentIdRef.id);
                process.stderr.write(`[ws-channel] Agent disconnected: ${agent?.name ?? agentIdRef.id}\n`);
                agents.delete(agentIdRef.id);
                channel.pushMessage(`Agent "${agent?.name ?? agentIdRef.id}" disconnected`, { chat_id: agentIdRef.id, user: "system", source: "websocket" }).catch(() => { });
            }
        });
        ws.on("error", (err) => {
            process.stderr.write(`[ws-channel] WS error: ${err.message}\n`);
        });
    }
    // ── Start / Stop server ────────────────────────────────────────────────────
    async function startServer() {
        if (serverRunning)
            return;
        const { WebSocketServer } = await import("ws");
        const port = cfg.port ?? 8080;
        const host = cfg.host ?? "0.0.0.0";
        // Try to start server; if port is taken, fall back to client mode (reuse existing WS)
        try {
            await new Promise((resolve, reject) => {
                wss = new WebSocketServer({ port, host });
                wss.once("listening", () => resolve());
                wss.once("error", (err) => {
                    if (err.code === "EADDRINUSE") {
                        wss = null;
                        reject(err);
                    }
                    else {
                        reject(err);
                    }
                });
            });
        }
        catch (err) {
            if (err?.code === "EADDRINUSE") {
                process.stderr.write(`[ws-channel] Port ${port} in use — joining as client to ws://localhost:${port}\n`);
                await connectToUrl(`ws://localhost:${port}`);
                return;
            }
            throw err;
        }
        wss.on("connection", (ws, req) => {
            const addr = req.socket.remoteAddress ?? "unknown";
            setupServerConnection(ws, addr);
        });
        const hbTimer = setInterval(() => {
            const now = Date.now();
            const staleThreshold = (cfg.heartbeatInterval ?? 30_000) * 3;
            for (const [id, agent] of agents) {
                if (now - agent.lastHeartbeat > staleThreshold) {
                    process.stderr.write(`[ws-channel] Agent stale, removing: ${agent.name} (${id})\n`);
                    agent.ws.close(4002, "Heartbeat timeout");
                    agents.delete(id);
                }
            }
        }, cfg.heartbeatInterval ?? 30_000);
        heartbeatTimers.push(hbTimer);
        serverRunning = true;
        process.stderr.write(`[ws-channel] Server listening on ${host}:${port}\n`);
    }
    function stopServer() {
        if (!serverRunning)
            return;
        if (wss) {
            wss.close();
            wss = null;
        }
        serverRunning = false;
        process.stderr.write(`[ws-channel] Server stopped\n`);
    }
    // ── Start / Stop client ────────────────────────────────────────────────────
    async function connectToUrl(url, isPeer = false) {
        const WebSocket = await import("ws");
        process.stderr.write(`[ws-channel] Connecting to ${url}${isPeer ? " (peer)" : ""}...\n`);
        const ws = new WebSocket.default(url);
        const agentIdRef = { id: null };
        ws.on("open", () => {
            process.stderr.write(`[ws-channel] Connected to ${url}\n`);
            // Use mesh JWT if available, otherwise legacy pair_token
            const authToken = meshCreateJwt
                ? meshCreateJwt(meshCfg?.deviceId ?? `agent-${process.pid}`)
                : cfg.pairToken;
            const registerMsg = {
                type: "register",
                agent_name: cfg.agentName ?? process.env.TALON_AGENT_NAME ?? `agent-${process.pid}`,
                pair_token: authToken,
                tools: cfg.tools ?? [],
                group_name: group?.name,
            };
            ws.send(JSON.stringify(registerMsg));
            // Reset reconnect backoff on successful connection
            reconnectTimers.__attempt = 0;
            const hbTimer = setInterval(() => {
                if (ws.readyState === WebSocket.default.OPEN) {
                    ws.send(JSON.stringify({ type: "heartbeat" }));
                }
            }, cfg.heartbeatInterval ?? 30_000);
            heartbeatTimers.push(hbTimer);
        });
        ws.on("message", (data) => {
            handleWsMessage(ws, data.toString(), agentIdRef);
        });
        ws.on("close", () => {
            process.stderr.write(`[ws-channel] Disconnected from ${url}\n`);
            if (cfg.autoReconnect !== false) {
                // Exponential backoff: 2s, 4s, 8s, 16s, 30s max
                const attempt = reconnectTimers.__attempt ?? 0;
                const delay = Math.min(2000 * Math.pow(2, attempt), 30000);
                reconnectTimers.__attempt = attempt + 1;
                const rt = setTimeout(() => {
                    process.stderr.write(`[ws-channel] Reconnecting to ${url} (attempt ${attempt + 1}, ${delay / 1000}s backoff)...\n`);
                    connectToUrl(url, isPeer);
                }, delay);
                reconnectTimers.push(rt);
            }
        });
        ws.on("error", (err) => {
            process.stderr.write(`[ws-channel] Connection error (${url}): ${err.message}\n`);
        });
        peerClients.push(ws);
    }
    function stopClients() {
        for (const rt of reconnectTimers)
            clearTimeout(rt);
        reconnectTimers.length = 0;
        // Disable auto-reconnect temporarily during stop
        const prevAutoReconnect = cfg.autoReconnect;
        cfg.autoReconnect = false;
        for (const ws of peerClients) {
            try {
                ws.close();
            }
            catch { }
        }
        peerClients.length = 0;
        cfg.autoReconnect = prevAutoReconnect;
        process.stderr.write(`[ws-channel] All client connections stopped\n`);
    }
    // ── Switch mode at runtime ─────────────────────────────────────────────────
    async function switchMode(newMode, newUrl) {
        const oldMode = currentMode;
        const needsServer = newMode === "server" || newMode === "both";
        const needsClient = newMode === "client" || newMode === "both";
        // Stop what's no longer needed
        if (!needsServer && serverRunning)
            stopServer();
        if (!needsClient && peerClients.length > 0)
            stopClients();
        // Start what's newly needed
        if (needsServer && !serverRunning)
            await startServer();
        if (needsClient) {
            const url = newUrl ?? clientUrl;
            if (url && peerClients.length === 0) {
                clientUrl = url;
                connectToUrl(url);
            }
            // Also reconnect group peers
            if (group?.peers) {
                for (const peerUrl of group.peers) {
                    connectToUrl(peerUrl, true);
                }
            }
        }
        currentMode = newMode;
        process.stderr.write(`[ws-channel] Mode switched: ${oldMode} → ${newMode}\n`);
        return `Mode switched from "${oldMode}" to "${newMode}"${needsServer ? ` (server on ${cfg.host ?? "0.0.0.0"}:${cfg.port ?? 8080})` : ""}${needsClient && clientUrl ? ` (client → ${clientUrl})` : ""}`;
    }
    // ── Initial startup based on configured mode ──────────────────────────────
    if (isServer)
        await startServer();
    if (isClient) {
        if (cfg.url) {
            connectToUrl(cfg.url);
        }
        else if (cfg.mode === "client") {
            process.stderr.write(`[ws-channel] Client mode requires WS_URL\n`);
        }
    }
    if (group?.peers) {
        for (const peerUrl of group.peers) {
            connectToUrl(peerUrl, true);
        }
    }
    // ── mDNS discovery: start + auto-connect to discovered peers ──────────────
    if (meshDiscovery) {
        meshDiscovery.on("peerDiscovered", (peer) => {
            const url = `ws://${peer.host}:${peer.port}`;
            // Don't connect if already connected to this host:port
            const alreadyConnected = Array.from(agents.values()).some((a) => a.metadata?.peerUrl === url);
            if (!alreadyConnected) {
                process.stderr.write(`[ws-channel] mDNS: auto-connecting to ${peer.name} at ${url}\n`);
                connectToUrl(url, true);
            }
        });
        await meshDiscovery.start();
    }
    // ── Registry: report endpoints + fetch remote peers ────────────────────────
    if (meshRegistry) {
        const port = cfg.port ?? 8080;
        await meshRegistry.setup().catch(() => { });
        meshRegistry.startReporting({ lan: [{ ip: "0.0.0.0", port }] });
        // Fetch registry peers and connect
        const registryPeers = await meshRegistry.getPeers().catch(() => []);
        for (const peer of registryPeers) {
            if (peer.host !== "unknown" && peer.port > 0) {
                const url = `ws://${peer.host}:${peer.port}`;
                connectToUrl(url, true);
            }
        }
    }
    // ── Tool Handler (all tools including ws_switch_mode) ────────────────────────
    channel.onToolCall(async (name, args) => {
        if (name === "ws_list_agents") {
            const list = Array.from(agents.values()).map((a) => ({
                id: a.id,
                name: a.name,
                tools: a.tools.map((t) => t.name),
                lastHeartbeat: a.lastHeartbeat,
                metadata: a.metadata,
                groupName: a.groupName,
                isPeer: a.isPeer,
            }));
            return JSON.stringify(list, null, 2);
        }
        if (name === "ws_call_tool") {
            const { agent_id, tool_name, args: toolArgs } = args;
            const agent = agents.get(agent_id);
            if (!agent)
                return JSON.stringify({ error: `Agent not found: ${agent_id}` });
            const hasTool = agent.tools.some((t) => t.name === tool_name);
            if (!hasTool)
                return JSON.stringify({ error: `Agent ${agent_id} does not have tool: ${tool_name}` });
            const callId = `call-${++callIdCounter}-${Date.now()}`;
            const msg = { type: "tool_call", call_id: callId, tool_name, args: toolArgs ?? {} };
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    pendingCalls.delete(callId);
                    resolve(JSON.stringify({ error: "Tool call timed out (60s)" }));
                }, 60_000);
                pendingCalls.set(callId, { resolve, reject, timer });
                wsSend(agent.ws, msg);
            });
        }
        if (name === "ws_send_message") {
            const { agent_id, content } = args;
            const agent = agents.get(agent_id);
            if (!agent)
                return JSON.stringify({ error: `Agent not found: ${agent_id}` });
            const msg = { type: "chat", chat_id: agent_id, content };
            wsSend(agent.ws, msg);
            return "sent";
        }
        if (name === "ws_broadcast") {
            const { content, group_name } = args;
            const targetGroup = group_name ?? group?.name;
            broadcastToGroup("claude", content, undefined, targetGroup);
            const count = Array.from(agents.values()).filter((a) => !targetGroup || a.groupName === targetGroup).length;
            return `Broadcast sent to ${count} agent(s)${targetGroup ? ` in group "${targetGroup}"` : ""}`;
        }
        if (name === "ws_group_info") {
            const { group_name } = args;
            const targetGroup = group_name ?? group?.name;
            const members = Array.from(agents.values())
                .filter((a) => !targetGroup || a.groupName === targetGroup)
                .map((a) => ({ id: a.id, name: a.name, tools: a.tools.map((t) => t.name), isPeer: a.isPeer }));
            const pending = Array.from(pendingGroupApprovals.values()).map((p) => ({
                agentName: p.agentName,
                code: p.code,
            }));
            const invites = Array.from(groupInvites.values()).map((inv) => ({
                code: inv.code,
                type: inv.type,
                uses: inv.uses,
                maxUses: inv.maxUses || "unlimited",
                expiresAt: inv.expiresAt || "never",
                label: inv.label,
            }));
            return JSON.stringify({
                group: targetGroup ?? "(no group)",
                access: group?.access ?? "none",
                maxMembers: group?.maxMembers ?? "unlimited",
                memberCount: members.length,
                members,
                pendingApprovals: pending,
                invites,
                mode: currentMode,
                serverRunning,
                clientConnections: peerClients.length,
            }, null, 2);
        }
        if (name === "ws_group_approve") {
            const { code } = args;
            const pendingApproval = pendingGroupApprovals.get(code);
            if (!pendingApproval)
                return JSON.stringify({ error: `No pending approval with code: ${code}` });
            pendingGroupApprovals.delete(code);
            const agentIdRef = { id: null };
            registerAgent(pendingApproval.ws, {
                type: "register",
                agent_name: pendingApproval.agentName,
                pair_token: cfg.pairToken,
                tools: pendingApproval.tools,
                metadata: pendingApproval.metadata,
                group_name: group?.name,
            }, agentIdRef);
            return `Approved agent "${pendingApproval.agentName}" into group "${group?.name ?? "default"}"`;
        }
        if (name === "ws_group_invite") {
            const { type: inviteType, label, ttl_minutes, max_uses } = args;
            const t = inviteType ?? "private";
            const code = generatePairingCode(8);
            const now = Date.now();
            const invite = {
                code,
                type: t,
                groupName: group?.name ?? "default",
                createdBy: "claude",
                createdAt: now,
                expiresAt: t === "public" ? 0 : now + (ttl_minutes ?? 60) * 60_000,
                uses: 0,
                maxUses: t === "public" ? (max_uses ?? 0) : (max_uses ?? 1),
                label,
            };
            groupInvites.set(code, invite);
            const port = cfg.port ?? 8080;
            const host = cfg.host ?? "0.0.0.0";
            const wsUrl = `ws://${host === "0.0.0.0" ? "localhost" : host}:${port}`;
            const link = `${wsUrl}?invite=${code}`;
            process.stderr.write(`[ws-channel] Invite created: ${code} (${t}${invite.expiresAt ? `, expires ${new Date(invite.expiresAt).toISOString()}` : ", no expiry"})\n`);
            return JSON.stringify({
                code,
                type: t,
                link,
                expiresAt: invite.expiresAt || null,
                maxUses: invite.maxUses || "unlimited",
                group: invite.groupName,
            }, null, 2);
        }
        if (name === "ws_switch_mode") {
            const { mode: newMode, url: newUrl } = args;
            return await switchMode(newMode, newUrl);
        }
        throw new Error(`Unknown tool: ${name}`);
    });
    // ── Cleanup ────────────────────────────────────────────────────────────────
    const cleanup = () => {
        for (const t of heartbeatTimers)
            clearInterval(t);
        for (const t of reconnectTimers)
            clearTimeout(t);
        if (wss)
            wss.close();
        if (httpServer)
            httpServer.close();
        for (const ws of peerClients) {
            try {
                ws.close();
            }
            catch { }
        }
        for (const [, pending] of pendingCalls) {
            clearTimeout(pending.timer);
        }
        if (meshDiscovery)
            meshDiscovery.stop();
        if (meshRegistry)
            meshRegistry.stop();
        channel.cleanup();
    };
    return { channel, cleanup, agents };
}
//# sourceMappingURL=websocket.js.map