/**
 * Client-mode test suite.
 *
 * Tests ChannelHub as a client: connect to server, send/receive messages,
 * proxy commands (groups, handover), state sync.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestHub, nextPort, delay, waitForEvent, startTestServer } from "./helpers.js";
import type { ChannelHub } from "../dist/index.js";

let serverHub: ChannelHub;
let clientHub: ChannelHub;
let port: number;

describe("ChannelHub Client Mode", () => {
  beforeEach(async () => {
    port = nextPort();
    serverHub = createTestHub({ name: "server-hub", port });
    await startTestServer(serverHub, port);

    clientHub = createTestHub({ name: "client-hub", port, agentName: "test-client" });
    await clientHub.connect(`ws://localhost:${port}`, "test-client");
    await delay(200); // allow registration to complete
  });

  afterEach(async () => {
    clientHub?.stopHealthMonitor();
    serverHub?.stopHealthMonitor();
    if (clientHub) for (const [, c] of clientHub.clients) { try { c.ws.close(); } catch {} }
    if (serverHub) for (const agent of serverHub.agents.values()) { try { agent.ws.close(); } catch {} }
    if (serverHub) for (const [, s] of serverHub.servers) { try { s.httpServer?.close(); s.wss?.close(); } catch {} }
    await delay(100);
  });

  // ── Connection state ──────────────────────────────────────────────────

  it("should connect as client to server", () => {
    expect(clientHub.clientConnected()).toBe(true);
    expect(clientHub.isClient()).toBe(true);
    expect(clientHub.serverRunning()).toBe(false);
  });

  it("should be registered as agent on server", () => {
    expect(serverHub.agents.size).toBe(1);
    const agent = serverHub.findAgent("test-client");
    expect(agent).toBeDefined();
    expect(agent!.name).toBe("test-client");
  });

  // ── sendMessage from server → client ──────────────────────────────────

  it("should receive messages from server", async () => {
    const msgPromise = waitForEvent(clientHub, "message");

    const agent = serverHub.findAgent("test-client")!;
    serverHub.wsSend(agent.ws, { type: "chat", chat_id: "from-server", content: "Hello client!", from: "server" });

    const msg = await msgPromise;
    expect(msg.content).toBe("Hello client!");
    expect(msg.chatId).toBe("from-server");
  });

  // ── sendMessage from client → server ──────────────────────────────────

  it("should send chat from client to server", async () => {
    const msgPromise = waitForEvent(serverHub, "message");

    const cws = clientHub.getClientWs();
    clientHub.wsSend(cws, { type: "chat", chat_id: "from-client", content: "Hello server!", from: "test-client" });

    const msg = await msgPromise;
    expect(msg.content).toBe("Hello server!");
    expect(msg.user).toBe("test-client");
  });

  // ── Proxy commands ────────────────────────────────────────────────────

  it("should proxy group operations to server", async () => {
    // Client creates a group via proxy
    const result = await clientHub.createGroup("proxy-group") as any;
    expect(result.ok).toBe(true);

    // Server should have the group
    const groups = serverHub.listGroups() as any[];
    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBe("proxy-group");
  });

  it("should proxy listGroups to server", async () => {
    serverHub.createGroup("existing-group");
    const groups = await clientHub.listGroups() as any[];
    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBe("existing-group");
  });

  it("should proxy listAgents to server", async () => {
    const agents = await clientHub.listAgents() as any[];
    expect(agents).toHaveLength(1);
    expect(agents[0].name).toBe("test-client");
  });

  it("should proxy handover and getChatRoute", async () => {
    const agent = serverHub.findAgent("test-client")!;

    const result = await clientHub.handover("proxy-chat", agent.id) as any;
    expect(result.ok).toBe(true);

    const route = await clientHub.getChatRoute("proxy-chat") as string;
    expect(route).toBe(agent.id);
  });

  it("should proxy releaseChat", async () => {
    const agent = serverHub.findAgent("test-client")!;
    serverHub.handover("rel-proxy", agent.id);
    await delay(100);

    const result = await clientHub.releaseChat("rel-proxy") as any;
    expect(result.ok).toBe(true);

    const route = await clientHub.getChatRoute("rel-proxy");
    expect(route).toBeUndefined();
  });

  // ── Tool calls via client → server → target agent ─────────────────────

  it("should proxy tool calls through server", async () => {
    // Connect a second agent to the server with tools
    const secondPort = port; // same server
    const { default: WebSocket } = await import("ws");
    const ws2 = new WebSocket(`ws://localhost:${secondPort}`);
    await new Promise<void>((resolve) => ws2.on("open", resolve));
    const msgs: any[] = [];
    ws2.on("message", (data: Buffer) => { try { msgs.push(JSON.parse(data.toString())); } catch {} });
    ws2.send(JSON.stringify({ type: "register", agent_name: "tool-provider", tools: [{ name: "echo", description: "Echo", inputSchema: { type: "object" } }] }));
    await delay(200);

    const toolProvider = serverHub.findAgent("tool-provider")!;

    // Client calls tool on tool-provider via server proxy
    const resultPromise = clientHub.callRemoteTool(toolProvider.id, "echo", { text: "ping" });

    // Wait for tool_call on the provider side
    await delay(200);
    const toolCall = msgs.find((m) => m.type === "tool_call");
    expect(toolCall).toBeDefined();
    expect(toolCall.tool_name).toBe("echo");

    // Provider responds
    ws2.send(JSON.stringify({ type: "tool_result", call_id: toolCall.call_id, result: "pong" }));
    const result = await resultPromise;
    expect(result).toBe("pong");

    ws2.close();
  });

  // ── Multiple clients ──────────────────────────────────────────────────

  it("should support multiple clients connected to same server", async () => {
    const client2 = createTestHub({ name: "client-2", agentName: "client-two" });
    await client2.connect(`ws://localhost:${port}`, "client-two");
    await delay(200);

    expect(serverHub.agents.size).toBe(2);
    expect(serverHub.findAgent("test-client")).toBeDefined();
    expect(serverHub.findAgent("client-two")).toBeDefined();

    for (const [, c] of client2.clients) {
      try { c.ws.close(); } catch {}
    }
  });
});
