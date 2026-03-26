#!/usr/bin/env node
/**
 * Talon Channels — Universal Channel Server
 *
 * A generic MCP server using the Talon Channel SDK that provides:
 * - WebSocket server for any client to connect (browser, mobile, desktop, bots)
 * - 21 platform-specific channel adapters (Telegram, Discord, Slack, etc.)
 * - Full 23 hook event forwarding
 * - Permission relay (approve/deny tool execution from any client)
 * - Bidirectional chat via channel notifications
 * - Client mode system (chat, monitor, full, custom)
 * - Multi-client support with independent modes
 *
 * Set TALON_CHANNEL env var to pick an adapter:
 *   - "websocket" (default): runs a local WebSocket server
 *   - "telegram", "discord", "slack", etc.: uses platform-specific adapter
 */
import { ChannelServer } from "./channel-server.js";
// ─── Channel Selection ────────────────────────────────────────────────────────
const SUPPORTED_CHANNELS = [
    "websocket",
    "telegram",
    "discord",
    "slack",
    "whatsapp",
    "signal",
    "imessage",
    "irc",
    "googlechat",
    "line",
    "feishu",
    "matrix",
    "mattermost",
    "msteams",
    "bluebubbles",
    "nostr",
    "nextcloud-talk",
    "synology-chat",
    "tlon",
    "twitch",
    "zalo",
    "zalouser",
];
const channelType = (process.env.TALON_CHANNEL ?? "websocket").toLowerCase();
if (!SUPPORTED_CHANNELS.includes(channelType)) {
    process.stderr.write(`[talon-channels] Unknown channel type: "${channelType}". Supported: ${SUPPORTED_CHANNELS.join(", ")}\n`);
    process.exit(1);
}
// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
    if (channelType === "websocket") {
        await startWebSocketChannel();
    }
    else {
        await startPlatformChannel(channelType);
    }
}
// ─── Platform Channel Mode ────────────────────────────────────────────────────
async function startPlatformChannel(channel) {
    process.stderr.write(`[talon-channels] Starting platform channel: ${channel}\n`);
    const mod = await import("./channels/index.js");
    const creators = {
        telegram: mod.createTelegramChannel,
        discord: mod.createDiscordChannel,
        slack: mod.createSlackChannel,
        whatsapp: mod.createWhatsAppChannel,
        signal: mod.createSignalChannel,
        imessage: mod.createIMessageChannel,
        irc: mod.createIrcChannel,
        googlechat: mod.createGoogleChatChannel,
        line: mod.createLineChannel,
        feishu: mod.createFeishuChannel,
        matrix: mod.createMatrixChannel,
        mattermost: mod.createMattermostChannel,
        msteams: mod.createMsTeamsChannel,
        bluebubbles: mod.createBlueBubblesChannel,
        nostr: mod.createNostrChannel,
        "nextcloud-talk": mod.createNextcloudTalkChannel,
        "synology-chat": mod.createSynologyChatChannel,
        tlon: mod.createTlonChannel,
        twitch: mod.createTwitchChannel,
        zalo: mod.createZaloChannel,
        zalouser: mod.createZaloUserChannel,
    };
    const create = creators[channel];
    if (!create) {
        process.stderr.write(`[talon-channels] No creator function found for channel: ${channel}\n`);
        process.exit(1);
    }
    const { channel: channelServer, cleanup } = await create();
    await channelServer.start();
    process.stderr.write(`[talon-channels] Platform channel "${channel}" is ready\n`);
    const shutdown = () => {
        process.stderr.write(`[talon-channels] Shutting down platform channel: ${channel}\n`);
        cleanup();
        process.exit(0);
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
}
// ─── WebSocket Channel Mode ──────────────────────────────────────────────────
async function startWebSocketChannel() {
    // Dynamic imports for WebSocket-only dependencies
    const http = await import("node:http");
    const createHttpServer = http.createServer;
    const wsMod = await import("ws");
    const WebSocketServer = wsMod.WebSocketServer;
    const WebSocket = wsMod.WebSocket;
    const { randomUUID } = await import("node:crypto");
    const { mkdirSync, writeFileSync, unlinkSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { homedir } = await import("node:os");
    const PORT = parseInt(process.env.TALON_CHANNELS_PORT ?? "21568", 10);
    const TALON_DIR = join(homedir(), ".talon");
    const CATEGORY_EVENTS = {
        chat: new Set(),
        tools: new Set(["PreToolUse", "PostToolUse", "PostToolUseFailure"]),
        permissions: new Set(["PermissionRequest"]),
        session: new Set(["SessionStart", "SessionEnd"]),
        notifications: new Set(["Notification"]),
        subagents: new Set(["SubagentStart", "SubagentStop"]),
        lifecycle: new Set(["Stop", "StopFailure", "TeammateIdle", "TaskCompleted"]),
        filesystem: new Set(["FileChanged", "CwdChanged", "ConfigChange", "InstructionsLoaded"]),
        worktree: new Set(["WorktreeCreate", "WorktreeRemove"]),
        compact: new Set(["PreCompact", "PostCompact"]),
        elicitation: new Set(["Elicitation", "ElicitationResult"]),
        prompts: new Set(["UserPromptSubmit"]),
    };
    function resolveAllowedEvents(mode, categories) {
        if (mode === "chat")
            return new Set();
        if (mode === "monitor" || mode === "full")
            return "all";
        const allowed = new Set();
        for (const cat of categories) {
            for (const ev of CATEGORY_EVENTS[cat] ?? [])
                allowed.add(ev);
        }
        return allowed;
    }
    function shouldForward(client, eventName) {
        if (client.allowedEvents === "all")
            return true;
        return client.allowedEvents.has(eventName);
    }
    // ─── WebSocket Server ──────────────────────────────────────────────
    const clients = new Map();
    const authToken = randomUUID();
    function broadcast(event, filter) {
        for (const client of clients.values()) {
            if (filter && !filter(client))
                continue;
            if (client.ws.readyState !== WebSocket.OPEN)
                continue;
            try {
                client.ws.send(JSON.stringify({
                    seq: client.seq++,
                    payload: { type: "event", event: event.type ?? "unknown", data: event },
                }));
            }
            catch { }
        }
    }
    function sendToClient(client, payload) {
        if (client.ws.readyState !== WebSocket.OPEN)
            return;
        try {
            client.ws.send(JSON.stringify({ seq: client.seq++, payload }));
        }
        catch { }
    }
    // ─── HTTP Routes ───────────────────────────────────────────────────
    function handleHttp(req, res) {
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type");
        if (req.method === "OPTIONS") {
            res.writeHead(204);
            res.end();
            return;
        }
        if (req.url === "/health" && req.method === "GET") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
                status: "ok",
                service: "talon-channels",
                channel: "websocket",
                clients: clients.size,
            }));
            return;
        }
        if (req.url === "/auth/local" && req.method === "POST") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ token: authToken }));
            return;
        }
        if (req.url === "/clients" && req.method === "GET") {
            res.writeHead(200, { "Content-Type": "application/json" });
            const list = [...clients.values()].map(c => ({
                id: c.id,
                mode: c.mode,
                name: c.name,
                allowsChat: c.allowsChat,
                allowsPermissions: c.allowsPermissions,
                connected: c.ws.readyState === WebSocket.OPEN,
            }));
            res.end(JSON.stringify(list));
            return;
        }
        res.writeHead(404);
        res.end("Not Found");
    }
    // ─── Start ─────────────────────────────────────────────────────────
    const channel = new ChannelServer({
        name: "talon-channels",
        version: "1.1.0",
        instructions: 'Messages from connected clients arrive as <channel source="talon-channels" chat_id="..." user="...">. ' +
            "Clients connect via WebSocket and can be browsers, mobile apps, desktop apps, or bots. " +
            "Reply with the reply tool, passing chat_id back. " +
            "This is a universal channel — any WebSocket client can connect and interact.",
        permissionRelay: true,
    });
    const httpServer = createHttpServer((req, res) => handleHttp(req, res));
    await new Promise((resolve, reject) => {
        httpServer.once("error", (err) => {
            if (err.code === "EADDRINUSE") {
                process.stderr.write(`[talon-channels] Port ${PORT} in use, using random port\n`);
                httpServer.listen(0, () => resolve());
            }
            else {
                reject(err);
            }
        });
        httpServer.listen(PORT, () => resolve());
    });
    const actualPort = httpServer.address().port;
    const wss = new WebSocketServer({ server: httpServer, path: "/ws" });
    // Write discovery files
    mkdirSync(TALON_DIR, { recursive: true });
    writeFileSync(join(TALON_DIR, "channels_port"), String(actualPort));
    writeFileSync(join(TALON_DIR, "channels_token"), authToken);
    process.stderr.write(`[talon-channels] WebSocket server on port ${actualPort}\n`);
    // ─── WebSocket Connections ─────────────────────────────────────────
    wss.on("connection", (ws, req) => {
        const url = new URL(req.url ?? "/", `http://localhost:${actualPort}`);
        const token = url.searchParams.get("token");
        if (token !== authToken) {
            ws.close(4001, "Invalid token");
            return;
        }
        const modeParam = (url.searchParams.get("mode") ?? "full");
        const categories = (url.searchParams.get("categories") ?? "")
            .split(",")
            .filter(Boolean);
        const clientName = url.searchParams.get("name") ?? undefined;
        const client = {
            id: randomUUID(),
            ws,
            mode: modeParam,
            categories,
            allowedEvents: resolveAllowedEvents(modeParam, categories),
            allowsChat: modeParam !== "monitor",
            allowsPermissions: modeParam === "full" || (modeParam === "custom" && categories.includes("permissions")),
            name: clientName,
            seq: Date.now(),
        };
        clients.set(client.id, client);
        process.stderr.write(`[talon-channels] Client connected: ${client.id} (mode=${client.mode}, name=${clientName ?? "anonymous"})\n`);
        // Send welcome
        sendToClient(client, {
            type: "connected",
            client_id: client.id,
            mode: client.mode,
            allows_chat: client.allowsChat,
            allows_permissions: client.allowsPermissions,
            available_modes: ["chat", "monitor", "full", "custom"],
            available_categories: Object.keys(CATEGORY_EVENTS),
        });
        ws.on("message", (data) => {
            try {
                const msg = JSON.parse(data.toString());
                // Mode switch
                if (msg.type === "set_mode") {
                    client.mode = msg.mode ?? "full";
                    client.categories = msg.categories ?? [];
                    client.allowedEvents = resolveAllowedEvents(client.mode, client.categories);
                    client.allowsChat = client.mode !== "monitor";
                    client.allowsPermissions = client.mode === "full" || (client.mode === "custom" && client.categories.includes("permissions"));
                    sendToClient(client, {
                        type: "mode_changed",
                        mode: client.mode,
                        categories: client.categories,
                        allows_chat: client.allowsChat,
                        allows_permissions: client.allowsPermissions,
                    });
                    return;
                }
                // Chat message from client
                if (msg.type === "chat_message" || (msg.type === "request" && msg.method === "send_message")) {
                    if (!client.allowsChat)
                        return;
                    const text = msg.text ?? msg.params?.message ?? "";
                    const chatId = msg.chat_id ?? msg.params?.conversation_id ?? `${client.id}-${Date.now()}`;
                    const meta = {
                        chat_id: chatId,
                        user: client.name ?? "client",
                        client_id: client.id,
                    };
                    if (msg.context?.url)
                        meta.url = msg.context.url;
                    if (msg.context?.title)
                        meta.title = msg.context.title;
                    channel.pushMessage(text, meta);
                    // Acknowledge
                    if (msg.id) {
                        sendToClient(client, { type: "response", id: msg.id, result: { ok: true } });
                    }
                    return;
                }
                // Permission verdict from client
                if (msg.type === "permission_verdict" && msg.request_id) {
                    if (!client.allowsPermissions)
                        return;
                    channel.sendPermissionVerdict({
                        request_id: msg.request_id,
                        behavior: msg.behavior === "allow" ? "allow" : "deny",
                    });
                    return;
                }
            }
            catch { }
        });
        ws.on("close", () => {
            clients.delete(client.id);
            process.stderr.write(`[talon-channels] Client disconnected: ${client.id}\n`);
        });
        ws.on("error", (err) => {
            process.stderr.write(`[talon-channels] Client error: ${err.message}\n`);
        });
    });
    // ─── Hook events → broadcast to clients ────────────────────────────
    channel.onHookEvent((input) => {
        broadcast({ type: "hook_event", hook_event_name: input.hook_event_name, data: input }, (c) => shouldForward(c, input.hook_event_name));
    });
    // ─── Permission relay → broadcast to clients that allow it ─────────
    channel.onPermissionRequest((request) => {
        broadcast({
            type: "permission_request",
            request_id: request.request_id,
            tool_name: request.tool_name,
            description: request.description,
            input_preview: request.input_preview,
        }, (c) => c.allowsPermissions);
    });
    // ─── Reply tool → broadcast to all chat-capable clients ────────────
    channel.onReply((chatId, text) => {
        let seq = Date.now();
        for (const client of clients.values()) {
            if (!client.allowsChat || client.ws.readyState !== WebSocket.OPEN)
                continue;
            try {
                client.ws.send(JSON.stringify({ seq: seq++, payload: { type: "stream", conversation_id: chatId, event: { type: "turn_started" } } }));
                client.ws.send(JSON.stringify({ seq: seq++, payload: { type: "stream", conversation_id: chatId, event: { type: "text_delta", text } } }));
                client.ws.send(JSON.stringify({ seq: seq++, payload: { type: "stream", conversation_id: chatId, event: { type: "stream_end", fullText: text } } }));
            }
            catch { }
        }
    });
    // ─── Start channel server (IPC socket + MCP stdio) ─────────────────
    await channel.start();
    process.stderr.write(`[talon-channels] Ready (ws=${actualPort}, clients=0)\n`);
    // ─── Graceful shutdown ─────────────────────────────────────────────
    const shutdown = () => {
        channel.cleanup();
        try {
            unlinkSync(join(TALON_DIR, "channels_port"));
        }
        catch { }
        try {
            unlinkSync(join(TALON_DIR, "channels_token"));
        }
        catch { }
        process.exit(0);
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
}
main().catch((err) => {
    process.stderr.write(`[talon-channels] Fatal: ${err}\n`);
    process.exit(1);
});
//# sourceMappingURL=server.js.map