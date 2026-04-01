/**
 * MCP-over-HTTP Channel Adapter
 *
 * Exposes the ChannelServer over HTTP transport instead of stdio.
 * Supports:
 * - SSE (Server-Sent Events) for server→client streaming
 * - HTTP POST for client→server requests
 * - Compatible with MCP Streamable HTTP transport spec
 * - Multiple concurrent clients
 * - Bearer token authentication
 * - CORS support
 */
import { ChannelServer } from "../channel-server.js";
import { HubConfigService } from "@gettalon/hub-runtime";
// ── Parse Config ───────────────────────────────────────────────────────────────
export function parseConfig() {
    const cfg = HubConfigService.fromEnv();
    return {
        port: cfg.mcpHttpPort(),
        host: cfg.mcpHttpHost(),
        bearerToken: cfg.mcpHttpToken(),
        corsOrigins: cfg.mcpHttpCors() ?? "*",
        basePath: cfg.mcpHttpPath(),
        agentName: cfg.mcpHttpAgentName(),
    };
}
// ── Create Channel ─────────────────────────────────────────────────────────────
export async function createMcpHttpChannel(config) {
    const http = await import("node:http");
    const cfg = { ...parseConfig(), ...config };
    const port = cfg.port ?? 3100;
    const host = cfg.host ?? "127.0.0.1";
    const basePath = (cfg.basePath ?? "/mcp").replace(/\/+$/, "");
    // SSE clients
    const sseClients = new Map();
    let clientIdCounter = 0;
    // Registered tools (from config + remote agents)
    const registeredTools = new Map();
    for (const tool of cfg.tools ?? []) {
        registeredTools.set(tool.name, { description: tool.description, inputSchema: tool.inputSchema });
    }
    // Pending tool results
    const pendingToolCalls = new Map();
    // Channel server (still uses stdio for Claude MCP connection)
    const channel = new ChannelServer({
        name: cfg.agentName ?? "mcp-http-agent",
        version: "1.0.0",
        instructions: [
            `This agent is accessible via MCP-over-HTTP at ${host}:${port}${basePath}.`,
            `Remote clients can connect via SSE for streaming and POST for requests.`,
        ].join("\n"),
        extraTools: [
            {
                name: "mcp_http_list_clients",
                description: "List all connected MCP-over-HTTP clients",
                inputSchema: { type: "object", properties: {}, required: [] },
            },
            {
                name: "mcp_http_notify",
                description: "Send a notification to all connected MCP-over-HTTP clients",
                inputSchema: {
                    type: "object",
                    properties: {
                        method: { type: "string", description: "Notification method name" },
                        params: { type: "object", description: "Notification parameters" },
                    },
                    required: ["method"],
                },
            },
        ],
    });
    channel.onToolCall(async (name, args) => {
        if (name === "mcp_http_list_clients") {
            return JSON.stringify(Array.from(sseClients.values()).map((c) => ({ id: c.id, lastPing: c.lastPing })), null, 2);
        }
        if (name === "mcp_http_notify") {
            const { method, params } = args;
            broadcastSse({ jsonrpc: "2.0", method, params: params ?? {} });
            return "notified";
        }
        // Forward to config handler
        if (cfg.onToolCall) {
            return await cfg.onToolCall(name, args);
        }
        throw new Error(`Unknown tool: ${name}`);
    });
    // ── SSE Helpers ────────────────────────────────────────────────────────────
    function broadcastSse(data) {
        const payload = `data: ${JSON.stringify(data)}\n\n`;
        for (const client of sseClients.values()) {
            try {
                client.res.write(payload);
            }
            catch {
                // Client disconnected
            }
        }
    }
    function sendSse(clientId, data) {
        const client = sseClients.get(clientId);
        if (client) {
            try {
                client.res.write(`data: ${JSON.stringify(data)}\n\n`);
            }
            catch { }
        }
    }
    // Forward channel events to SSE clients
    channel.on("hookEvent", (input) => {
        broadcastSse({ type: "hook_event", input });
    });
    channel.on("reply", (chatId, text) => {
        broadcastSse({ type: "reply", chat_id: chatId, text });
    });
    channel.on("permissionRequest", (request) => {
        broadcastSse({ type: "permission_request", request });
    });
    // ── HTTP Server ────────────────────────────────────────────────────────────
    function authenticate(req) {
        if (!cfg.bearerToken)
            return true;
        const auth = req.headers.authorization ?? "";
        return auth === `Bearer ${cfg.bearerToken}`;
    }
    function setCors(res) {
        res.setHeader("Access-Control-Allow-Origin", cfg.corsOrigins ?? "*");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    }
    function readBody(req) {
        return new Promise((resolve, reject) => {
            let body = "";
            req.on("data", (chunk) => { body += chunk.toString(); });
            req.on("end", () => resolve(body));
            req.on("error", reject);
        });
    }
    async function handleJsonRpc(req, clientId) {
        const { method, params, id } = req;
        // MCP initialize
        if (method === "initialize") {
            return {
                jsonrpc: "2.0",
                id,
                result: {
                    protocolVersion: "2024-11-05",
                    serverInfo: { name: cfg.agentName ?? "mcp-http", version: "1.0.0" },
                    capabilities: {
                        tools: {},
                        experimental: { "claude/channel": {}, "claude/channel/permission": {} },
                    },
                },
            };
        }
        // MCP tools/list
        if (method === "tools/list") {
            const tools = Array.from(registeredTools.entries()).map(([name, { description, inputSchema }]) => ({
                name,
                description,
                inputSchema,
            }));
            return { jsonrpc: "2.0", id, result: { tools } };
        }
        // MCP tools/call
        if (method === "tools/call") {
            const { name, arguments: args } = (params ?? {});
            try {
                let result;
                if (cfg.onToolCall) {
                    result = await cfg.onToolCall(name, args ?? {});
                }
                else {
                    result = { error: `No handler for tool: ${name}` };
                }
                const text = typeof result === "string" ? result : JSON.stringify(result);
                return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } };
            }
            catch (err) {
                return { jsonrpc: "2.0", id, error: { code: -32603, message: String(err) } };
            }
        }
        // Channel message (push to Claude)
        if (method === "channel/message") {
            const { content, chat_id, meta } = (params ?? {});
            await channel.pushMessage(content, {
                chat_id: chat_id ?? clientId ?? "http",
                source: "mcp-http",
                ...(meta ?? {}),
            });
            return { jsonrpc: "2.0", id, result: { status: "pushed" } };
        }
        // Permission verdict
        if (method === "channel/permission_verdict") {
            const { request_id, behavior } = (params ?? {});
            await channel.sendPermissionVerdict({ request_id, behavior });
            return { jsonrpc: "2.0", id, result: { status: "sent" } };
        }
        // Ping
        if (method === "ping") {
            return { jsonrpc: "2.0", id, result: {} };
        }
        return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
    }
    const server = http.createServer(async (req, res) => {
        setCors(res);
        // CORS preflight
        if (req.method === "OPTIONS") {
            res.writeHead(204);
            res.end();
            return;
        }
        const url = req.url ?? "";
        // Auth check
        if (!authenticate(req)) {
            res.writeHead(401, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Unauthorized" }));
            return;
        }
        // SSE endpoint: GET /mcp/sse
        if (req.method === "GET" && url.startsWith(`${basePath}/sse`)) {
            const clientId = `sse-${++clientIdCounter}`;
            res.writeHead(200, {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                Connection: "keep-alive",
                "X-Client-Id": clientId,
            });
            // Send endpoint info
            res.write(`data: ${JSON.stringify({ type: "endpoint", post_url: `${basePath}/message?client_id=${clientId}` })}\n\n`);
            sseClients.set(clientId, { id: clientId, res, lastPing: Date.now() });
            process.stderr.write(`[mcp-http] SSE client connected: ${clientId}\n`);
            // Keepalive ping
            const pingInterval = setInterval(() => {
                try {
                    res.write(`: ping\n\n`);
                    const client = sseClients.get(clientId);
                    if (client)
                        client.lastPing = Date.now();
                }
                catch {
                    clearInterval(pingInterval);
                }
            }, 15_000);
            req.on("close", () => {
                clearInterval(pingInterval);
                sseClients.delete(clientId);
                process.stderr.write(`[mcp-http] SSE client disconnected: ${clientId}\n`);
            });
            return;
        }
        // JSON-RPC endpoint: POST /mcp/message
        if (req.method === "POST" && url.startsWith(`${basePath}/message`)) {
            const urlObj = new URL(url, `http://${req.headers.host}`);
            const clientId = urlObj.searchParams.get("client_id") ?? undefined;
            try {
                const body = await readBody(req);
                const rpcReq = JSON.parse(body);
                const rpcRes = await handleJsonRpc(rpcReq, clientId);
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify(rpcRes));
            }
            catch (err) {
                res.writeHead(400, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: `Parse error: ${err}` } }));
            }
            return;
        }
        // Health check: GET /mcp/health
        if (req.method === "GET" && url.startsWith(`${basePath}/health`)) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
                status: "ok",
                agent: cfg.agentName,
                clients: sseClients.size,
                tools: registeredTools.size,
            }));
            return;
        }
        // Not found
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not found" }));
    });
    server.listen(port, host, () => {
        process.stderr.write(`[mcp-http] Listening on ${host}:${port}${basePath}\n`);
        process.stderr.write(`[mcp-http]   SSE: GET ${basePath}/sse\n`);
        process.stderr.write(`[mcp-http]   RPC: POST ${basePath}/message\n`);
        process.stderr.write(`[mcp-http]   Health: GET ${basePath}/health\n`);
    });
    const cleanup = () => {
        server.close();
        for (const client of sseClients.values()) {
            try {
                client.res.end();
            }
            catch { }
        }
        channel.cleanup();
    };
    const url = `http://${host === "0.0.0.0" ? "localhost" : host}:${port}${basePath}`;
    return { channel, cleanup, url };
}
//# sourceMappingURL=mcp-http.js.map