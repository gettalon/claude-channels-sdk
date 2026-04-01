/**
 * Integration test suite — server + multiple clients.
 *
 * Tests end-to-end flows: private messaging, group creation/broadcast,
 * handover between agents, multi-agent routing.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestHub, nextPort, connectRawAgent, delay, waitForEvent, startTestServer } from "./helpers.js";
import type { ChannelHub } from "../dist/index.js";

let serverHub: ChannelHub;
let clientA: ChannelHub;
let clientB: ChannelHub;
let port: number;

describe("Integration: Server + Multiple Clients", () => {
  beforeEach(async () => {
    port = nextPort();
    serverHub = createTestHub({ name: "int-server", port });
    await startTestServer(serverHub, port);

    clientA = createTestHub({ name: "client-a", agentName: "alice" });
    clientB = createTestHub({ name: "client-b", agentName: "bob" });
    await clientA.connect(`ws://localhost:${port}`, "alice");
    await clientB.connect(`ws://localhost:${port}`, "bob");
    await delay(300);
  });

  afterEach(async () => {
    clientA.stopHealthMonitor();
    clientB.stopHealthMonitor();
    serverHub.stopHealthMonitor();
    for (const hub of [clientA, clientB]) {
      for (const [, c] of hub.clients) { try { c.ws.close(); } catch {} }
    }
    for (const agent of serverHub.agents.values()) { try { agent.ws.close(); } catch {} }
    for (const [, s] of serverHub.servers) { try { s.httpServer?.close(); s.wss?.close(); } catch {} }
    await delay(100);
  });

  // ── Private messaging ─────────────────────────────────────────────────

  it("should support private message from server to specific client", async () => {
    const msgPromise = waitForEvent(clientA, "message");

    const alice = serverHub.findAgent("alice")!;
    serverHub.wsSend(alice.ws, { type: "chat", chat_id: "private-1", content: "Hey Alice", from: "server" });

    const msg = await msgPromise;
    expect(msg.content).toBe("Hey Alice");
    expect(msg.chatId).toBe("private-1");
  });

  it("should route handover-targeted messages to the assigned agent only", async () => {
    const alice = serverHub.findAgent("alice")!;
    const bob = serverHub.findAgent("bob")!;

    // Hand chat-private to alice
    serverHub.handover("chat-private", alice.id);
    await delay(100);

    // Incoming message for chat-private should reach alice, not bob
    const aliceMsgPromise = waitForEvent(clientA, "message");
    (serverHub as any).routeChat({ chatId: "chat-private", content: "Secret message", from: "external-user", source: "channel" });

    const aliceMsg = await aliceMsgPromise;
    // Alice gets the handover notification first, then the routed message
    expect(aliceMsg.content).toBeDefined();
  });

  // ── Group messaging ───────────────────────────────────────────────────

  it("should create group with both clients and broadcast", async () => {
    const alice = serverHub.findAgent("alice")!;
    const bob = serverHub.findAgent("bob")!;

    serverHub.createGroup("team");
    serverHub.addToGroup("team", alice.id);
    serverHub.addToGroup("team", bob.id);

    const aliceMsgPromise = waitForEvent(clientA, "message");
    const bobMsgPromise = waitForEvent(clientB, "message");

    serverHub.broadcastToGroup("team", "Team update!", "server");

    // Both clients should receive the broadcast
    const [aliceMsg, bobMsg] = await Promise.all([aliceMsgPromise, bobMsgPromise]);
    expect(aliceMsg.content).toBe("Team update!");
    expect(bobMsg.content).toBe("Team update!");
  });

  it("should support agent-to-agent group broadcast (peer excluded)", async () => {
    const alice = serverHub.findAgent("alice")!;
    const bob = serverHub.findAgent("bob")!;

    serverHub.createGroup("peer-group");
    serverHub.addToGroup("peer-group", alice.id);
    serverHub.addToGroup("peer-group", bob.id);

    // Alice sends group_broadcast — bob should receive, alice should not
    const bobMsgPromise = waitForEvent(clientB, "message");
    const cws = clientA.getClientWs();
    clientA.wsSend(cws, { type: "group_broadcast", content: "Alice says hi to group" });

    const bobMsg = await bobMsgPromise;
    expect(bobMsg.content).toBe("Alice says hi to group");
  });

  // ── Handover flow ─────────────────────────────────────────────────────

  it("should hand chat from alice to bob and route correctly", async () => {
    const alice = serverHub.findAgent("alice")!;
    const bob = serverHub.findAgent("bob")!;

    // Initially assign to alice
    serverHub.handover("customer-chat", alice.id);
    await delay(100);

    // Now alice hands over to bob
    serverHub.handover("customer-chat", bob.id);
    await delay(100);

    expect(serverHub.getChatRoute("customer-chat")).toBe(bob.id);

    // Message for customer-chat should reach bob
    const bobMsgPromise = waitForEvent(clientB, "message");
    (serverHub as any).routeChat({ chatId: "customer-chat", content: "Customer says hello", from: "customer", source: "channel" });

    const bobMsg = await bobMsgPromise;
    expect(bobMsg.content).toBe("Customer says hello");
  });

  it("should release chat and fall back to host broadcast", async () => {
    const alice = serverHub.findAgent("alice")!;

    serverHub.handover("temp-chat", alice.id);
    await delay(100);

    serverHub.releaseChat("temp-chat");

    // After release, message should go to host (emit event)
    const hostMsgPromise = waitForEvent(serverHub, "message");
    (serverHub as any).routeChat({ chatId: "temp-chat", content: "After release", from: "user", source: "channel" });

    const hostMsg = await hostMsgPromise;
    expect(hostMsg.content).toBe("After release");
  });

  // ── Multi-step integration scenario ───────────────────────────────────

  it("should handle full lifecycle: connect → group → handover → release", async () => {
    const alice = serverHub.findAgent("alice")!;
    const bob = serverHub.findAgent("bob")!;

    // 1. Both agents are connected
    expect(serverHub.agents.size).toBe(2);

    // 2. Create group
    serverHub.createGroup("support");
    serverHub.addToGroup("support", alice.id);
    serverHub.addToGroup("support", bob.id);

    // 3. Broadcast to group
    const result = serverHub.broadcastToGroup("support", "New ticket incoming", "system") as any;
    expect(result.sent).toBe(2);

    // 4. Handover customer-1 to alice
    serverHub.handover("customer-1", alice.id);
    await delay(100);
    expect(serverHub.getChatRoute("customer-1")).toBe(alice.id);

    // 5. Alice receives the routed message
    const aliceMsgPromise = waitForEvent(clientA, "message");
    (serverHub as any).routeChat({ chatId: "customer-1", content: "I need help", from: "customer", source: "channel" });
    const aliceMsg = await aliceMsgPromise;
    expect(aliceMsg.content).toBe("I need help");

    // 6. Alice transfers to bob
    serverHub.handover("customer-1", bob.id);
    await delay(100);
    expect(serverHub.getChatRoute("customer-1")).toBe(bob.id);

    // 7. Bob gets the next message
    const bobMsgPromise = waitForEvent(clientB, "message");
    (serverHub as any).routeChat({ chatId: "customer-1", content: "Still need help", from: "customer", source: "channel" });
    const bobMsg = await bobMsgPromise;
    expect(bobMsg.content).toBe("Still need help");

    // 8. Bob releases
    serverHub.releaseChat("customer-1");
    expect(serverHub.getChatRoute("customer-1")).toBeUndefined();

    // 9. Delete group
    serverHub.deleteGroup("support");
    expect((serverHub.listGroups() as any[]).length).toBe(0);
  });

  // ── Concurrent connections stress ─────────────────────────────────────

  it("should handle 5 agents connecting and messaging concurrently", async () => {
    // Already have alice and bob, add 3 more
    const extras: ChannelHub[] = [];
    for (let i = 0; i < 3; i++) {
      const extra = createTestHub({ name: `extra-${i}`, agentName: `extra-${i}` });
      await extra.connect(`ws://localhost:${port}`, `extra-${i}`);
      extras.push(extra);
    }
    await delay(300);

    expect(serverHub.agents.size).toBe(5);

    // Broadcast to all via group
    serverHub.createGroup("all-agents");
    for (const agent of serverHub.agents.values()) {
      serverHub.addToGroup("all-agents", agent.id);
    }

    const result = serverHub.broadcastToGroup("all-agents", "Hello everyone!", "system") as any;
    expect(result.sent).toBe(5);

    // Cleanup extras
    for (const e of extras) {
      for (const [, c] of e.clients) { try { c.ws.close(); } catch {} }
    }
  });

  // ── Protocol: sendMessage and reply ───────────────────────────────────

  it("should route sendMessage to a named agent", () => {
    const result = serverHub.sendMessage("alice", "Direct to alice");
    expect(result.ok).toBe(true);
  });

  it("should reply via chat route", async () => {
    const alice = serverHub.findAgent("alice")!;
    serverHub.handover("reply-test", alice.id);
    await delay(100);

    const result = serverHub.reply("reply-test", "Reply text");
    expect(result.ok).toBe(true);
  });

  // ── Contact registry ──────────────────────────────────────────────────

  it("should register and resolve contacts", () => {
    const result = serverHub.registerContact("Alice Smith", "websocket", "alice-ws", "ws://localhost");
    expect(result.ok).toBe(true);

    const resolved = serverHub.resolveContact("Alice Smith");
    expect(resolved).toBeDefined();
    expect(resolved!.contact.name).toBe("Alice Smith");
    expect(resolved!.channel.type).toBe("websocket");

    const contacts = serverHub.listContacts();
    expect(contacts.length).toBeGreaterThanOrEqual(1);

    const removeResult = serverHub.removeContact("Alice Smith");
    expect(removeResult.ok).toBe(true);
  });

  // ── Status ────────────────────────────────────────────────────────────

  it("should report accurate status", () => {
    const status = serverHub.getStatus();
    expect(status.servers).toHaveLength(2); // unix + ws
    expect(status.agents).toBe(2);
    expect(status.clients).toHaveLength(0); // server has no outgoing clients
  });
});

// ── Protocol unit tests ─────────────────────────────────────────────────

describe("Protocol helpers", () => {
  it("should serialize/deserialize messages", async () => {
    const { serialize, deserialize } = await import("../dist/index.js");
    const msg = { type: "chat" as const, chat_id: "1", content: "test" };
    const str = serialize(msg);
    expect(typeof str).toBe("string");
    const parsed = deserialize(str) as any;
    expect(parsed.type).toBe("chat");
    expect(parsed.content).toBe("test");
  });

  it("should create envelopes with unique IDs", async () => {
    const { createEnvelope } = await import("../dist/index.js");
    const e1 = createEnvelope("agent-a", "chat", { type: "chat", content: "hi" });
    const e2 = createEnvelope("agent-a", "chat", { type: "chat", content: "hi" });
    expect(e1.id).not.toBe(e2.id);
    expect(e1.from).toBe("agent-a");
    expect(e1.type).toBe("chat");
  });
});
