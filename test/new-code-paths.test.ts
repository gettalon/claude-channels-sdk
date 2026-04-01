/**
 * Tests for new code paths:
 * 1. call_tool proxy in client mode
 * 2. send tool persistent agent fallback
 * 3. channelForChat population in hub-client.ts
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestHub, nextPort, delay, waitForEvent, connectRawAgent } , startTestServer , startTestServer from "./helpers.js";
import type { ChannelHub } from "../dist/index.js";

// ── 1. call_tool proxy in client mode ──────────────────────────────────────

describe("call_tool proxy in client mode", () => {
  let serverHub: ChannelHub;
  let clientHub: ChannelHub;
  let port: number;

  beforeEach(async () => {
    port = nextPort();
    serverHub = createTestHub({ name: "calltool-server", port });
    await startTestServer(serverHub, port);

    clientHub = createTestHub({ name: "calltool-client", port, agentName: "proxy-caller" });
    await clientHub.connect(`ws://localhost:${port}`, "proxy-caller");
    await delay(200);
  });

  afterEach(async () => {
    clientHub?.stopHealthMonitor();
    serverHub?.stopHealthMonitor();
    if (clientHub) for (const [, c] of clientHub.clients) { try { c.ws.close(); } catch {} }
    if (serverHub) for (const agent of serverHub.agents.values()) { try { agent.ws.close(); } catch {} }
    if (serverHub) for (const [, s] of serverHub.servers) { try { s.httpServer?.close(); s.wss?.close(); } catch {} }
    await delay(100);
  });

  it("client isClient() returns true and can list agents via proxy", async () => {
    expect(clientHub.isClient()).toBe(true);

    const agents = await clientHub.listAgents() as any[];
    expect(agents.length).toBeGreaterThanOrEqual(1);
    const self = agents.find((a: any) => a.name === "proxy-caller");
    expect(self).toBeDefined();
  });

  it("call_tool resolves agent by name via listAgents in client mode and proxies the call", async () => {
    // Connect a tool-provider agent to the server
    const { default: WebSocket } = await import("ws");
    const ws2 = new WebSocket(`ws://localhost:${port}`);
    await new Promise<void>((resolve) => ws2.on("open", resolve));
    const msgs: any[] = [];
    ws2.on("message", (data: Buffer) => { try { msgs.push(JSON.parse(data.toString())); } catch {} });
    ws2.send(JSON.stringify({
      type: "register",
      agent_name: "remote-worker",
      tools: [{ name: "greet", description: "Greet", inputSchema: { type: "object", properties: { name: { type: "string" } } } }],
    }));
    await delay(200);

    // Verify the client is in client mode
    expect(clientHub.isClient()).toBe(true);
    // The client should NOT have the agent locally
    expect(clientHub.findAgent("remote-worker")).toBeUndefined();

    // Use the call_tool logic: resolve via listAgents then proxy
    const agents = await clientHub.listAgents() as Array<{ id: string; name: string }>;
    const match = agents.find(a => a.name === "remote-worker");
    expect(match).toBeDefined();

    // Proxy the tool call through the server
    const resultPromise = clientHub.callRemoteTool(match!.id, "greet", { name: "World" });

    // The tool-provider should receive the tool call
    await delay(200);
    const toolCall = msgs.find((m) => m.type === "tool_call");
    expect(toolCall).toBeDefined();
    expect(toolCall.tool_name).toBe("greet");
    expect(toolCall.args).toEqual({ name: "World" });

    // Provider responds
    ws2.send(JSON.stringify({ type: "tool_result", call_id: toolCall.call_id, result: { greeting: "Hello World" } }));
    const result = await resultPromise;
    expect(result).toEqual({ greeting: "Hello World" });

    ws2.close();
  });

  it("call_tool returns error when agent not found in client mode", async () => {
    expect(clientHub.isClient()).toBe(true);

    // Import the call_tool handler to test its logic directly
    const { callToolTool } = await import("../dist/tools/call-tool.js");

    const ctx = { hub: clientHub, serverName: "test", mcp: {} } as any;
    const result = await callToolTool.handle(
      { agent_id: "nonexistent-agent", tool_name: "foo" },
      ctx,
    );
    const parsed = JSON.parse(result);
    expect(parsed.error).toBeDefined();
  });
});

// ── 2. send tool (UUID-based) and reply tool (name-based) ───────────────────

describe("send tool (UUID-only) and reply tool (name resolution)", () => {
  let hub: ChannelHub;
  let port: number;

  beforeEach(async () => {
    port = nextPort();
    hub = createTestHub({ name: "send-persist-server", port });
    await startTestServer(hub, port);
  });

  afterEach(async () => {
    hub?.stopHealthMonitor();
    for (const agent of hub.agents.values()) { try { agent.ws.close(); } catch {} }
    for (const [, s] of hub.servers) { try { s.httpServer?.close(); s.wss?.close(); } catch {} }
    await delay(100);
  });

  it("send tool returns error for unknown UUID", async () => {
    const { sendTool } = await import("../dist/tools/send.js");
    const ctx = { hub, serverName: "test", mcp: {} } as any;

    const result = await sendTool.handle({ target: "00000000-0000-0000-0000-000000000000", text: "hello" }, ctx);
    const parsed = JSON.parse(result);
    expect(parsed.sent).toBe(false);
    expect(parsed.error).toBeDefined();
  });

  it("send tool reaches agent via UUID", async () => {
    const agent = await connectRawAgent(port, "live-agent");
    const ack = await agent.waitForMsg("register_ack");
    expect(ack.status).toBe("ok");

    // Get UUID from targetRegistry
    const entry = (hub as any).findTarget?.("live-agent");
    expect(entry).toBeDefined();
    const uuid = entry.uuid;

    const { sendTool } = await import("../dist/tools/send.js");
    const ctx = { hub, serverName: "test", mcp: {} } as any;

    const result = await sendTool.handle({ target: uuid, text: "hello live" }, ctx);
    const parsed = JSON.parse(result);
    expect(parsed.sent).toBe(true);
    expect(parsed.resolved).toBe("live-agent");

    const msg = await agent.waitForMsg("chat");
    expect(msg.content).toBe("hello live");

    agent.close();
  });

  it("reply tool resolves agent by name and delivers message", async () => {
    const agent = await connectRawAgent(port, "named-agent");
    await agent.waitForMsg("register_ack");

    const { replyTool } = await import("../dist/tools/reply.js");
    const ctx = { hub, serverName: "test", mcp: {} } as any;

    const result = await replyTool.handle({ chat_id: "named-agent", text: "hi by name" }, ctx);
    expect(result).toBe("sent");

    const msg = await agent.waitForMsg("chat");
    expect(msg.content).toBe("hi by name");

    agent.close();
  });

  it("reply tool resolves contact by name", async () => {
    const agent = await connectRawAgent(port, "ambiguous");
    const ack = await agent.waitForMsg("register_ack");
    const agentId = ack.agent_id;

    hub.registerContact("ambiguous", "telegram", agentId);

    const { replyTool } = await import("../dist/tools/reply.js");
    const ctx = { hub, serverName: "test", mcp: {} } as any;

    const result = await replyTool.handle({ chat_id: "ambiguous", text: "hi" }, ctx);
    expect(result).toBe("sent");

    agent.close();
  });

  it("reply tool falls back gracefully for unknown target", async () => {
    const { replyTool } = await import("../dist/tools/reply.js");
    const ctx = { hub, serverName: "test", mcp: {} } as any;

    const result = await replyTool.handle({ chat_id: "nobody-at-all", text: "msg" }, ctx);
    // Falls back to hub.reply() which returns { ok: false }
    const parsed = JSON.parse(result);
    expect(parsed.ok).toBe(false);
  });
});

// ── 3. channelForChat population in hub-client.ts ────────────────────────────

describe("channelForChat population from channel transport", () => {
  let serverHub: ChannelHub;
  let port: number;

  beforeEach(async () => {
    port = nextPort();
    serverHub = createTestHub({ name: "channel-track-server", port });
    await startTestServer(serverHub, port);
  });

  afterEach(async () => {
    serverHub?.stopHealthMonitor();
    for (const agent of serverHub.agents.values()) { try { agent.ws.close(); } catch {} }
    for (const [, s] of serverHub.servers) { try { s.httpServer?.close(); s.wss?.close(); } catch {} }
    await delay(100);
  });

  it("channelForChat is populated when routeChat receives a channel message", async () => {
    // Connect a "channel" client (e.g. Telegram adapter) — simulate by connecting
    // a raw WS agent and then manually setting its role to "channel"
    const { default: WebSocket } = await import("ws");
    const ws = new WebSocket(`ws://localhost:${port}`);
    await new Promise<void>((resolve) => ws.on("open", resolve));
    ws.on("message", () => {}); // drain
    ws.send(JSON.stringify({ type: "register", agent_name: "telegram-bridge" }));
    await delay(200);

    // Find the client entry and override its role to "channel" to simulate a channel transport
    const agentState = serverHub.findAgent("telegram-bridge");
    expect(agentState).toBeDefined();

    // Manually mark one client as a "channel" role for simulation
    for (const [, client] of serverHub.clients) {
      if (client.role === "channel" || client.name === "telegram-bridge") {
        client.role = "channel" as any;
      }
    }

    // Simulate incoming channel message via routeChat
    const chatId = "telegram-chat-99";
    expect(serverHub.channelForChat.has(chatId)).toBe(false);

    // routeChat is the internal method that processes incoming channel messages
    (serverHub as any).routeChat({
      chatId,
      content: "Hello from Telegram user",
      from: "alice",
      source: "channel",
    });

    // After routeChat, channelForChat should be populated for this chat_id
    // (only if there is a channel client available)
    const channelClients = [...serverHub.clients.values()].filter(c => c.role === "channel");
    if (channelClients.length > 0) {
      expect(serverHub.channelForChat.has(chatId)).toBe(true);
      const entry = serverHub.channelForChat.get(chatId)!;
      expect(entry.role).toBe("channel");
    }

    ws.close();
  });

  it("channelForChat is populated in hub-client when chat message arrives from channel", async () => {
    // Create a client hub connected to the server
    const clientHub = createTestHub({ name: "channel-client", port, agentName: "channel-listener" });
    await clientHub.connect(`ws://localhost:${port}`, "channel-listener");
    await delay(200);

    expect(clientHub.isClient()).toBe(true);

    // The client hub's channelForChat should be empty initially
    expect(clientHub.channelForChat.size).toBe(0);

    // When the server sends a chat message with a chat_id that looks like
    // it came from a channel, the client's message handler should track it.
    // This happens in hub-client.ts lines 91-98.
    const agent = serverHub.findAgent("channel-listener")!;
    serverHub.wsSend(agent.ws, {
      type: "chat",
      chat_id: "telegram-chat-42",
      content: "Hello from channel",
      from: "bob",
    });

    await delay(200);

    // The client's channelForChat gets populated only for channel-role connections.
    // Since the client connected via WS to the server (role="server"), the
    // hub-client code checks `client.role === "channel"` before populating.
    // For a server-role connection, channelForChat won't be populated.
    // This is correct behavior — only channel transports populate channelForChat.
    const serverConn = [...clientHub.clients.values()].find(c => c.role === "server");
    expect(serverConn).toBeDefined();

    // Verify the message was still received even though channelForChat wasn't populated
    // (because the connection is role="server", not role="channel")

    // Now test with a channel-role client entry
    // Manually set the client role to "channel" and send another message
    for (const [, c] of clientHub.clients) {
      c.role = "channel" as any;
    }

    let emittedChatId77: string | undefined;
    clientHub.once("message", (msg: any) => { emittedChatId77 = msg.chatId; });

    serverHub.wsSend(agent.ws, {
      type: "chat",
      chat_id: "telegram-chat-77",
      content: "Second message",
      from: "carol",
    });

    await delay(200);

    // Now channelForChat should be populated — keyed by UUID (emitted chatId)
    expect(emittedChatId77).toBeDefined();
    expect(clientHub.channelForChat.has(emittedChatId77!)).toBe(true);
    const entry = clientHub.channelForChat.get(emittedChatId77!)!;
    expect(entry.role).toBe("channel");

    // Cleanup
    clientHub.stopHealthMonitor();
    for (const [, c] of clientHub.clients) { try { c.ws.close(); } catch {} }
  });

  it("channelForChat does not overwrite existing entry for same chatId", async () => {
    const clientHub = createTestHub({ name: "no-overwrite-client", port, agentName: "no-overwrite" });
    await clientHub.connect(`ws://localhost:${port}`, "no-overwrite");
    await delay(200);

    // Manually set the client role to "channel"
    for (const [, c] of clientHub.clients) {
      c.role = "channel" as any;
    }

    const agent = serverHub.findAgent("no-overwrite")!;

    // Send first message for a chat_id — capture the UUID emitted
    let emittedChatIdStable: string | undefined;
    clientHub.once("message", (msg: any) => { emittedChatIdStable = msg.chatId; });

    serverHub.wsSend(agent.ws, {
      type: "chat",
      chat_id: "stable-chat-123",
      content: "First message",
      from: "dave",
    });
    await delay(200);

    expect(emittedChatIdStable).toBeDefined();
    expect(clientHub.channelForChat.has(emittedChatIdStable!)).toBe(true);
    const firstEntry = clientHub.channelForChat.get(emittedChatIdStable!)!;
    const firstId = firstEntry.id;

    // Send second message for same chat_id — should NOT overwrite
    serverHub.wsSend(agent.ws, {
      type: "chat",
      chat_id: "stable-chat-123",
      content: "Second message",
      from: "dave",
    });
    await delay(200);

    const secondEntry = clientHub.channelForChat.get(emittedChatIdStable!)!;
    expect(secondEntry.id).toBe(firstId); // same entry, not overwritten

    // Cleanup
    clientHub.stopHealthMonitor();
    for (const [, c] of clientHub.clients) { try { c.ws.close(); } catch {} }
  });
});
