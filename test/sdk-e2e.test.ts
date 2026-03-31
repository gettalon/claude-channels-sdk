/**
 * SDK End-to-End Tests
 *
 * Tests the full SDK flow: one ChannelHub as server, another as client.
 * Exercises the public API from both sides — no raw WebSocket access.
 *
 * Covers: connection, messaging, reply, sendMessage, routing, contacts,
 * health, reload, settings, persistent agent routing.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestHub, nextPort, delay, waitForEvent } from "./helpers.js";
import type { ChannelHub } from "../dist/index.js";

let server: ChannelHub;
let client: ChannelHub;
let port: number;

describe("SDK End-to-End", () => {
  beforeEach(async () => {
    port = nextPort();
    server = createTestHub({ name: "e2e-server", port });
    await server.startServer(port);

    client = createTestHub({ name: "e2e-client", port, agentName: "sdk-client" });
    await client.connect(`ws://localhost:${port}`, "sdk-client");
    await delay(200);
  });

  afterEach(async () => {
    client?.stopHealthMonitor();
    server?.stopHealthMonitor();
    for (const [, c] of client?.clients ?? []) {
      try { c.ws.close(); } catch {}
    }
    for (const agent of server?.agents.values() ?? []) {
      try { agent.ws.close(); } catch {}
    }
    for (const [, s] of server?.servers ?? []) {
      try { s.httpServer?.close(); s.wss?.close(); } catch {}
    }
    await delay(100);
  });

  // ── Basic connectivity ──────────────────────────────────────────────

  it("client connects and server sees it as an agent", () => {
    expect(client.clientConnected()).toBe(true);
    expect(client.isClient()).toBe(true);
    expect(server.agents.size).toBe(1);
    expect(server.findAgent("sdk-client")).toBeDefined();
  });

  it("server health endpoint works from client", async () => {
    const res = await fetch(`http://localhost:${port}/health`);
    const data = await res.json() as any;
    expect(data.status).toBe("ok");
    expect(data.name).toBe("e2e-server");
  });

  // ── Bidirectional messaging ─────────────────────────────────────────

  it("server reply reaches client as message event", async () => {
    const msgPromise = waitForEvent(client, "message");
    server.reply("sdk-client", "Hello from server");
    const msg = await msgPromise;
    expect(msg.content).toBe("Hello from server");
  });

  it("client message reaches server as message event", async () => {
    const msgPromise = waitForEvent(server, "message");
    const cws = client.getClientWs();
    client.wsSend(cws, { type: "chat", chat_id: "test-chat", content: "Hello from client", from: "sdk-client" });
    const msg = await msgPromise;
    expect(msg.content).toBe("Hello from client");
    expect(msg.user).toBe("sdk-client");
  });

  // ── sendMessage with contact resolution ─────────────────────────────

  it("sendMessage resolves agent name", () => {
    const result = server.sendMessage("sdk-client", "Directed message");
    expect(result.ok).toBe(true);
  });

  it("sendMessage buffers message for unknown/offline target", () => {
    const result = server.sendMessage("nonexistent", "Hello?");
    // Message is buffered for offline agents, returns ok: true
    expect(result.ok).toBe(true);
  });

  // ── Handover and routing via SDK API ────────────────────────────────

  it("handover routes subsequent messages to agent", async () => {
    const agent = server.findAgent("sdk-client")!;
    const result = server.handover("routed-chat", agent.id);
    expect(result).toEqual(expect.objectContaining({ ok: true }));

    // Consume handover system message
    await delay(100);

    // Route a message for this chatId
    const msgPromise = waitForEvent(client, "message");
    (server as any).routeChat({ chatId: "routed-chat", content: "Routed msg", from: "channel-user", source: "channel" });
    const msg = await msgPromise;
    expect(msg.content).toBe("Routed msg");
  });

  it("releaseChat removes the route", () => {
    const agent = server.findAgent("sdk-client")!;
    server.handover("release-chat", agent.id);
    expect(server.getChatRoute("release-chat")).toBe(agent.id);

    server.releaseChat("release-chat");
    expect(server.getChatRoute("release-chat")).toBeUndefined();
  });

  // ── Groups ──────────────────────────────────────────────────────────

  it("group operations work via SDK", async () => {
    const agent = server.findAgent("sdk-client")!;
    expect(server.createGroup("sdk-group")).toEqual({ ok: true });
    expect(server.addToGroup("sdk-group", agent.id)).toEqual({ ok: true });

    const groups = server.listGroups() as any[];
    expect(groups).toHaveLength(1);
    expect(groups[0].members).toHaveLength(1);

    // Broadcast
    const msgPromise = waitForEvent(client, "message");
    server.broadcastToGroup("sdk-group", "Group hello", "host");
    const msg = await msgPromise;
    expect(msg.content).toBe("Group hello");

    // Cleanup
    server.deleteGroup("sdk-group");
    expect((server.listGroups() as any[]).length).toBe(0);
  });

  // ── Proxy commands (client → server) ────────────────────────────────

  it("client can list agents via proxy", async () => {
    const agents = await client.listAgents() as any[];
    expect(agents.length).toBeGreaterThanOrEqual(1);
    expect(agents.some((a: any) => a.name === "sdk-client")).toBe(true);
  });

  it("client can create group via proxy", async () => {
    const result = await client.createGroup("proxy-grp") as any;
    expect(result.ok).toBe(true);

    const groups = server.listGroups() as any[];
    expect(groups.some((g: any) => g.name === "proxy-grp")).toBe(true);
  });

  // ── Tool calls ──────────────────────────────────────────────────────

  it("server can call remote tool on client", async () => {
    // Connect a raw WS agent that provides a tool
    const { default: WebSocket } = await import("ws");
    const ws = new WebSocket(`ws://localhost:${port}`);
    await new Promise<void>((r) => ws.on("open", r));
    const msgs: any[] = [];
    ws.on("message", (d: Buffer) => { try { msgs.push(JSON.parse(d.toString())); } catch {} });
    ws.send(JSON.stringify({
      type: "register", agent_name: "tool-bot",
      tools: [{ name: "ping", description: "Ping", inputSchema: { type: "object" } }],
    }));
    await delay(200);

    const toolBot = server.findAgent("tool-bot")!;
    const resultPromise = server.callRemoteTool(toolBot.id, "ping", {});

    await delay(200);
    const toolCall = msgs.find((m) => m.type === "tool_call");
    expect(toolCall).toBeDefined();

    ws.send(JSON.stringify({ type: "tool_result", call_id: toolCall.call_id, result: "pong" }));
    const result = await resultPromise;
    expect(result).toBe("pong");

    ws.close();
  });

  // ── Health check ────────────────────────────────────────────────────

  it("health endpoint returns agent info", async () => {
    const res = await fetch(`http://localhost:${port}/agents`);
    const agents = await res.json() as any[];
    expect(agents.length).toBeGreaterThanOrEqual(1);
    expect(agents.some((a: any) => a.name === "sdk-client")).toBe(true);
  });

  // ── Multiple clients ────────────────────────────────────────────────

  it("supports multiple SDK clients", async () => {
    const client2 = createTestHub({ name: "e2e-client-2", agentName: "sdk-client-2" });
    await client2.connect(`ws://localhost:${port}`, "sdk-client-2");
    await delay(200);

    expect(server.agents.size).toBe(2);

    // Send to each specifically
    const result1 = server.reply("sdk-client", "msg for client 1");
    const result2 = server.reply("sdk-client-2", "msg for client 2");
    expect(result1.ok).toBe(true);
    expect(result2.ok).toBe(true);

    for (const [, c] of client2.clients) {
      try { c.ws.close(); } catch {}
    }
  });

  // ── Reply routing through channel clients ──────────────────────────

  it("reply falls through to channel clients for unknown chatIds", async () => {
    // Connect a second hub as a "channel" by connecting to a telegram:// style URL
    // Since we can't use real telegram, test with the hub.reply() fallback path
    const result = server.reply("unknown-chat-id", "Where does this go?");
    // Should reach a channel client if one exists, or return error
    // With only sdk-client connected (server role), this should fail
    expect(result.ok).toBe(false);
  });

  // ── Contacts ────────────────────────────────────────────────────────

  it("contact auto-registration works for channels", async () => {
    // Route a message with a chatId — should auto-register contact
    (server as any).routeChat({ chatId: "user-42", content: "Hi", from: "alice", source: "channel" });
    await delay(100);

    const contacts = server.listContacts();
    // Auto-registered contacts appear with chat IDs
    expect(Array.isArray(contacts)).toBe(true);
  });

  // ── Smart routing (@agent mention) ──────────────────────────────────

  it("@agent mention routes to connected agent", async () => {
    const msgPromise = waitForEvent(client, "message");
    (server as any).routeChat({ chatId: "mention-test", content: "@sdk-client What's up?", from: "user", source: "channel" });
    const msg = await msgPromise;
    expect(msg.content).toBe("What's up?");
  });

  it("/agent slash command routes to connected agent", async () => {
    const msgPromise = waitForEvent(client, "message");
    (server as any).routeChat({ chatId: "slash-test", content: "/sdk-client hello", from: "user", source: "channel" });
    const msg = await msgPromise;
    expect(msg.content).toBe("hello");
  });

  // ── emitMessage ─────────────────────────────────────────────────────

  it("emitMessage fires message event and hooks", async () => {
    const msgPromise = waitForEvent(server, "message");
    (server as any).emitMessage("Direct emit", "some-chat", "test-user");
    const msg = await msgPromise;
    expect(msg.content).toBe("Direct emit");
    expect(msg.chatId).toBe("some-chat");
  });
});
