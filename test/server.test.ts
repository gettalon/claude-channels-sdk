/**
 * Server-mode test suite.
 *
 * Tests ChannelHub as a server: start server, accept agent connections,
 * routing, handover, groups, approval/pairing.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestHub, nextPort, connectRawAgent, waitForEvent, delay, startTestServer } from "./helpers.js";
import type { ChannelHub } from "../dist/index.js";

let hub: ChannelHub;
let port: number;

describe("ChannelHub Server Mode", () => {
  beforeEach(async () => {
    port = nextPort();
    hub = createTestHub({ name: "test-server", port });
    await startTestServer(hub, port);
  });

  afterEach(async () => {
    // Close all agent connections
    for (const agent of hub.agents.values()) {
      try { agent.ws.close(); } catch {}
    }
    // Close servers (Unix + HTTP+WS)
    for (const [, s] of hub.servers) {
      try { s.httpServer?.close(); s.wss?.close(); } catch {}
    }
    // Clean up Unix socket
    try { const { unlinkSync } = await import("node:fs"); unlinkSync(`/tmp/talon-${port}.sock`); } catch {}
    hub.stopHealthMonitor();
    await delay(100);
  });

  // ── Server lifecycle ──────────────────────────────────────────────────

  it("should start Unix + HTTP+WS server", () => {
    expect(hub.serverRunning()).toBe(true);
    // servers map has unix:{port} and ws:{port} entries
    expect(hub.servers.size).toBe(2);
  });

  it("should respond to /health endpoint", async () => {
    const res = await fetch(`http://localhost:${port}/health`);
    expect(res.ok).toBe(true);
    const data = await res.json() as any;
    expect(data.status).toBe("ok");
    expect(data.name).toBe("test-server");
    expect(data.port).toBe(port);
  });

  it("should respond to /agents endpoint", async () => {
    const res = await fetch(`http://localhost:${port}/agents`);
    expect(res.ok).toBe(true);
    const data = await res.json() as any;
    expect(Array.isArray(data)).toBe(true);
    expect(data).toHaveLength(0);
  });

  it("should not start duplicate server on same port", async () => {
    const result = await hub.startServer(port);
    expect(result.port).toBe(port);
    expect(hub.servers.size).toBe(2); // unix + ws, no duplicates
  });

  // ── Agent registration ────────────────────────────────────────────────

  it("should register an agent via WebSocket", async () => {
    const agent = await connectRawAgent(port, "agent-alpha", [
      { name: "greet", description: "Say hello", inputSchema: { type: "object" } },
    ]);
    const ack = await agent.waitForMsg("register_ack");
    expect(ack.status).toBe("ok");
    expect(ack.agent_id).toBeDefined();
    expect(hub.agents.size).toBe(1);

    const found = hub.findAgent("agent-alpha");
    expect(found).toBeDefined();
    expect(found!.name).toBe("agent-alpha");
    expect(found!.tools).toHaveLength(1);

    agent.close();
  });

  it("should handle agent reconnect (same name replaces)", async () => {
    const agent1 = await connectRawAgent(port, "agent-beta");
    await agent1.waitForMsg("register_ack");
    expect(hub.agents.size).toBe(1);
    const id1 = hub.findAgent("agent-beta")!.id;

    const agent2 = await connectRawAgent(port, "agent-beta");
    await agent2.waitForMsg("register_ack");
    expect(hub.agents.size).toBe(1); // still one — replaced
    const id2 = hub.findAgent("agent-beta")!.id;
    expect(id2).toBe(id1); // same ID reused

    agent1.close();
    agent2.close();
  });

  it("should emit agentConnected event", async () => {
    const eventPromise = waitForEvent(hub, "agentConnected");
    const agent = await connectRawAgent(port, "agent-gamma");
    await agent.waitForMsg("register_ack");
    const event = await eventPromise;
    expect(event.name).toBe("agent-gamma");
    agent.close();
  });

  it("should show agents on /agents endpoint after connection", async () => {
    const agent = await connectRawAgent(port, "agent-delta", [
      { name: "calc", description: "Calculate", inputSchema: { type: "object" } },
    ]);
    await agent.waitForMsg("register_ack");

    const res = await fetch(`http://localhost:${port}/agents`);
    const data = await res.json() as any;
    expect(data).toHaveLength(1);
    expect(data[0].name).toBe("agent-delta");
    expect(data[0].tools).toContain("calc");

    agent.close();
  });

  // ── Heartbeat ─────────────────────────────────────────────────────────

  it("should respond to heartbeat", async () => {
    const agent = await connectRawAgent(port, "agent-hb");
    await agent.waitForMsg("register_ack");

    agent.send({ type: "heartbeat" });
    const ack = await agent.waitForMsg("heartbeat_ack");
    expect(ack.type).toBe("heartbeat_ack");

    agent.close();
  });

  // ── Chat routing ──────────────────────────────────────────────────────

  it("should route agent chat to host via message event", async () => {
    const agent = await connectRawAgent(port, "agent-chat");
    await agent.waitForMsg("register_ack");

    const msgPromise = waitForEvent(hub, "message");
    agent.send({ type: "chat", chat_id: "room-1", content: "Hello host!" });
    const msg = await msgPromise;
    expect(msg.content).toBe("Hello host!");
    expect(msg.chatId).toBe("room-1");
    expect(msg.user).toBe("agent-chat");

    agent.close();
  });

  it("should route chat between two agents via target", async () => {
    const agent1 = await connectRawAgent(port, "sender");
    const agent2 = await connectRawAgent(port, "receiver");
    await agent1.waitForMsg("register_ack");
    await agent2.waitForMsg("register_ack");

    // sender sends a targeted message to receiver
    agent1.send({ type: "chat", chat_id: "dm-1", content: "Hey receiver!", target: "receiver" });
    const received = await agent2.waitForMsg("chat");
    expect(received.content).toBe("Hey receiver!");
    expect(received.from).toBe("sender");

    agent1.close();
    agent2.close();
  });

  // ── Handover ──────────────────────────────────────────────────────────

  it("should hand over a chat to an agent", async () => {
    const agent = await connectRawAgent(port, "handler-agent");
    await agent.waitForMsg("register_ack");

    const agentState = hub.findAgent("handler-agent")!;
    const result = hub.handover("chat-123", agentState.id);
    expect(result).toEqual(expect.objectContaining({ ok: true }));

    // Verify route was created
    const route = hub.getChatRoute("chat-123");
    expect(route).toBe(agentState.id);

    // Agent should receive a system message about the handover
    const sysMsg = await agent.waitForMsg("chat");
    expect(sysMsg.from).toBe("system");
    expect(sysMsg.meta?.handover).toBe("true");

    agent.close();
  });

  it("should route messages to handed-over agent", async () => {
    const agent = await connectRawAgent(port, "owned-agent");
    await agent.waitForMsg("register_ack");

    const agentState = hub.findAgent("owned-agent")!;
    hub.handover("chat-x", agentState.id);
    // consume the system handover message
    await agent.waitForMsg("chat");

    // Now route a chat message for chat-x — should go to the agent
    (hub as any).routeChat({ chatId: "chat-x", content: "User says hi", from: "user", source: "channel" });
    const msg = await agent.waitForMsg("chat");
    expect(msg.content).toBe("User says hi");
    expect(msg.chat_id).toBe("chat-x");

    agent.close();
  });

  it("should release a chat back to host", async () => {
    const agent = await connectRawAgent(port, "release-agent");
    await agent.waitForMsg("register_ack");

    const agentState = hub.findAgent("release-agent")!;
    hub.handover("chat-rel", agentState.id);
    await agent.waitForMsg("chat"); // consume handover msg

    const result = hub.releaseChat("chat-rel");
    expect(result).toEqual(expect.objectContaining({ ok: true }));
    expect(hub.getChatRoute("chat-rel")).toBeUndefined();

    agent.close();
  });

  it("should support agent-initiated release", async () => {
    const agent = await connectRawAgent(port, "self-release-agent");
    await agent.waitForMsg("register_ack");

    const agentState = hub.findAgent("self-release-agent")!;
    hub.handover("chat-sr", agentState.id);
    await agent.waitForMsg("chat"); // consume handover msg

    agent.send({ type: "release", chat_id: "chat-sr" });
    const ack = await agent.waitForMsg("ack");
    expect(ack.status).toBe("ok");
    expect(hub.getChatRoute("chat-sr")).toBeUndefined();

    agent.close();
  });

  it("should support agent-initiated handover to another agent", async () => {
    const agent1 = await connectRawAgent(port, "passer");
    const agent2 = await connectRawAgent(port, "receiver-ho");
    await agent1.waitForMsg("register_ack");
    await agent2.waitForMsg("register_ack");

    const a1 = hub.findAgent("passer")!;
    hub.handover("chat-ho", a1.id);
    await agent1.waitForMsg("chat"); // consume handover msg

    agent1.send({ type: "handover", chat_id: "chat-ho", to_agent: "receiver-ho" });
    const ack = await agent1.waitForMsg("ack");
    expect(ack.status).toBe("ok");

    // receiver should get the handover notification
    const sysMsg = await agent2.waitForMsg("chat");
    expect(sysMsg.meta?.handover).toBe("true");

    // Route should now point to agent2
    const a2 = hub.findAgent("receiver-ho")!;
    expect(hub.getChatRoute("chat-ho")).toBe(a2.id);

    agent1.close();
    agent2.close();
  });

  // ── Groups ────────────────────────────────────────────────────────────

  it("should create and manage groups", async () => {
    const agent1 = await connectRawAgent(port, "g-agent-1");
    const agent2 = await connectRawAgent(port, "g-agent-2");
    await agent1.waitForMsg("register_ack");
    await agent2.waitForMsg("register_ack");

    // Create group
    expect(hub.createGroup("team-alpha")).toEqual({ ok: true });
    expect(hub.createGroup("team-alpha")).toEqual(expect.objectContaining({ ok: false }));

    // Add members by name (auto-resolves to ws:name)
    expect(hub.addToGroup("team-alpha", "g-agent-1")).toEqual({ ok: true });
    expect(hub.addToGroup("team-alpha", "g-agent-2")).toEqual({ ok: true });

    // List
    const groups = hub.listGroups() as any[];
    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBe("team-alpha");
    expect(groups[0].members).toHaveLength(2);

    // Remove by name
    expect(hub.removeFromGroup("team-alpha", "g-agent-1")).toEqual({ ok: true });
    const groups2 = hub.listGroups() as any[];
    expect(groups2[0].members).toHaveLength(1);

    // Delete
    expect(hub.deleteGroup("team-alpha")).toEqual({ ok: true });
    expect((hub.listGroups() as any[]).length).toBe(0);

    agent1.close();
    agent2.close();
  });

  it("should broadcast to group members", async () => {
    const agent1 = await connectRawAgent(port, "bc-agent-1");
    const agent2 = await connectRawAgent(port, "bc-agent-2");
    await agent1.waitForMsg("register_ack");
    await agent2.waitForMsg("register_ack");

    hub.createGroup("bc-group");
    hub.addToGroup("bc-group", "bc-agent-1");
    hub.addToGroup("bc-group", "bc-agent-2");

    const result = hub.broadcastToGroup("bc-group", "Hello group!", "host") as any;
    expect(result.ok).toBe(true);
    expect(result.sent).toBe(2);

    const msg1 = await agent1.waitForMsg("group_broadcast");
    const msg2 = await agent2.waitForMsg("group_broadcast");
    expect(msg1.content).toBe("Hello group!");
    expect(msg2.content).toBe("Hello group!");

    agent1.close();
    agent2.close();
  });

  it("should support agent-to-agent group broadcast", async () => {
    const agent1 = await connectRawAgent(port, "gb-agent-1");
    const agent2 = await connectRawAgent(port, "gb-agent-2");
    await agent1.waitForMsg("register_ack");
    await agent2.waitForMsg("register_ack");

    hub.createGroup("gb-group");
    hub.addToGroup("gb-group", "gb-agent-1");
    hub.addToGroup("gb-group", "gb-agent-2");

    // agent1 sends group_broadcast — agent2 should receive it, agent1 should not
    agent1.send({ type: "group_broadcast", content: "From agent 1", meta: { group: "gb-group" } });
    const msg = await agent2.waitForMsg("group_broadcast");
    expect(msg.content).toBe("From agent 1");
    expect(msg.from).toBe("gb-agent-1");

    agent1.close();
    agent2.close();
  });

  // ── Tool call ─────────────────────────────────────────────────────────

  it("should forward tool_call to agent and receive result", async () => {
    const agent = await connectRawAgent(port, "tool-agent", [
      { name: "add", description: "Add two numbers", inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } } } },
    ]);
    await agent.waitForMsg("register_ack");

    const agentState = hub.findAgent("tool-agent")!;

    // Listen for tool_call on the agent side and respond
    const toolCallPromise = agent.waitForMsg("tool_call");
    const resultPromise = hub.callRemoteTool(agentState.id, "add", { a: 2, b: 3 });

    const toolCall = await toolCallPromise;
    expect(toolCall.tool_name).toBe("add");
    expect(toolCall.args).toEqual({ a: 2, b: 3 });

    // Agent sends result back
    agent.send({ type: "tool_result", call_id: toolCall.call_id, result: 5 });
    const result = await resultPromise;
    expect(result).toBe(5);

    agent.close();
  });

  // ── Envelope & routing ────────────────────────────────────────────────

  it("should create and route session envelopes", async () => {
    const agent = await connectRawAgent(port, "env-agent");
    await agent.waitForMsg("register_ack");

    const envelope = hub.wrapEnvelope({ type: "chat", chat_id: "e1", content: "Envelope test" }, { to: "env-agent" });
    expect(envelope.from).toBe("test-server");
    expect(envelope.type).toBe("chat");
    expect(envelope.to).toBe("env-agent");

    const delivered = hub.route(envelope);
    expect(delivered).toBe(1);

    const msg = await agent.waitForMsg("chat");
    expect(msg.content).toBe("Envelope test");

    agent.close();
  });

  it("should broadcast envelope to all agents", async () => {
    const a1 = await connectRawAgent(port, "env-a1");
    const a2 = await connectRawAgent(port, "env-a2");
    await a1.waitForMsg("register_ack");
    await a2.waitForMsg("register_ack");

    const envelope = hub.wrapEnvelope({ type: "chat", chat_id: "bc-env", content: "Broadcast env" });
    const delivered = hub.route(envelope, "agent-only");
    expect(delivered).toBe(2);

    const msg1 = await a1.waitForMsg("chat");
    const msg2 = await a2.waitForMsg("chat");
    expect(msg1.content).toBe("Broadcast env");
    expect(msg2.content).toBe("Broadcast env");

    a1.close();
    a2.close();
  });

  // ── Disconnect cleanup ────────────────────────────────────────────────

  it("should clean up on agent disconnect", async () => {
    const agent = await connectRawAgent(port, "disconnect-agent");
    await agent.waitForMsg("register_ack");
    expect(hub.agents.size).toBe(1);

    const agentState = hub.findAgent("disconnect-agent")!;
    hub.handover("dc-chat", agentState.id);
    hub.createGroup("dc-group");
    hub.addToGroup("dc-group", agentState.id);

    agent.close();
    await delay(200);

    expect(hub.agents.size).toBe(0);
    expect(hub.getChatRoute("dc-chat")).toBeUndefined();
    const group = (hub.listGroups() as any[])[0];
    expect(group.members).toHaveLength(0);
  });
});
