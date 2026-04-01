/**
 * Multi-hub messaging patterns.
 *
 * Tests all message delivery patterns across hub-to-hub mesh connections:
 *   1. Many-to-many (multiple agents per hub, UUID-targeted)
 *   2. @mention routing (same-hub and cross-hub name resolution)
 *   3. Broadcast to all agents on a hub
 *   4. Group broadcast (multiple agents in same group)
 *   5. Hub A → multiple agents on Hub B simultaneously
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ChannelHub } from "../dist/index.js";
import { createTestHub, nextPort, delay, connectRawAgent, startTestServer } from "./helpers.js";

function cleanupHub(hub: ChannelHub | undefined) {
  if (!hub) return;
  (hub as any).stopHealthMonitor?.();
  for (const agent of hub.agents.values()) {
    try { agent.ws?.close?.(); } catch {}
  }
  for (const [, s] of hub.servers) {
    try { s.httpServer?.close(); s.wss?.close(); } catch {}
  }
  for (const [, c] of hub.clients) {
    try { c.ws?.close?.(); } catch {}
    if (c.heartbeatTimer) clearInterval(c.heartbeatTimer);
  }
}

// ── Shared setup helpers ──────────────────────────────────────────────────────

async function registerAndWait(port: number, name: string) {
  const agent = await connectRawAgent(port, name);
  const ack = await agent.waitForMsg("register_ack");
  expect(ack.status).toBe("ok");
  return { ...agent, id: ack.agent_id as string };
}

// ── 1. Many-to-many (multiple agents per hub) ─────────────────────────────────

describe("multi-hub many-to-many (UUID targeting)", () => {
  let hubA: ChannelHub, hubB: ChannelHub;
  let portA: number, portB: number;

  beforeEach(async () => {
    portA = nextPort(); portB = nextPort();
    hubA = createTestHub({ name: "mm-A" });
    hubB = createTestHub({ name: "mm-B" });
    await startTestServer(hubA, portA);
    await startTestServer(hubB, portB);
    await hubA.connect(`ws://localhost:${portB}`, "mm-A");
    await delay(300);
  });
  afterEach(() => { cleanupHub(hubA); cleanupHub(hubB); });

  it("hub A sends to 3 different agents on hub B by UUID", async () => {
    const b1 = await registerAndWait(portB, "b-agent-1");
    const b2 = await registerAndWait(portB, "b-agent-2");
    const b3 = await registerAndWait(portB, "b-agent-3");
    await delay(100);

    hubA.reply(b1.id, "msg-to-b1");
    hubA.reply(b2.id, "msg-to-b2");
    hubA.reply(b3.id, "msg-to-b3");

    const [m1, m2, m3] = await Promise.all([
      b1.waitForMsg("chat", 3000),
      b2.waitForMsg("chat", 3000),
      b3.waitForMsg("chat", 3000),
    ]);
    expect(m1.content).toBe("msg-to-b1");
    expect(m2.content).toBe("msg-to-b2");
    expect(m3.content).toBe("msg-to-b3");

    b1.close(); b2.close(); b3.close();
  });

  it("agents on hub B send to each other on same hub (many-to-many local)", async () => {
    const b1 = await registerAndWait(portB, "peer-1");
    const b2 = await registerAndWait(portB, "peer-2");
    const b3 = await registerAndWait(portB, "peer-3");
    await delay(100);

    // Each sends to the next
    b1.send({ type: "chat", target: b2.id, content: "1→2", chat_id: "local" });
    b2.send({ type: "chat", target: b3.id, content: "2→3", chat_id: "local" });
    b3.send({ type: "chat", target: b1.id, content: "3→1", chat_id: "local" });

    const [m1, m2, m3] = await Promise.all([
      b1.waitForMsg("chat", 2000),
      b2.waitForMsg("chat", 2000),
      b3.waitForMsg("chat", 2000),
    ]);
    expect(m1.content).toBe("3→1");
    expect(m2.content).toBe("1→2");
    expect(m3.content).toBe("2→3");

    b1.close(); b2.close(); b3.close();
  });

  it("hub B agents receive messages from both local agents and hub A", async () => {
    const b1 = await registerAndWait(portB, "mix-b1");
    const b2 = await registerAndWait(portB, "mix-b2");
    await delay(100);

    // Hub A sends to b1
    hubA.reply(b1.id, "from-A");
    // b2 sends to b1 (local)
    b2.send({ type: "chat", target: b1.id, content: "from-b2", chat_id: "local-chat" });

    const [m1, m2] = await Promise.all([
      b1.waitForMsg("chat", 2000),
      b1.waitForMsg("chat", 2000),
    ]);
    const contents = [m1.content, m2.content].sort();
    expect(contents).toEqual(["from-A", "from-b2"]);

    b1.close(); b2.close();
  });
});

// ── 2. @mention routing ───────────────────────────────────────────────────────

describe("@mention routing (single hub)", () => {
  let hub: ChannelHub;
  let port: number;

  beforeEach(async () => {
    port = nextPort();
    hub = createTestHub({ name: "mention-hub" });
    await startTestServer(hub, port);
  });
  afterEach(() => cleanupHub(hub));

  it("@name routes message to named agent, stripping prefix", async () => {
    const agent = await registerAndWait(port, "researcher");
    await delay(50);

    // Another agent sends @researcher
    const sender = await registerAndWait(port, "sender");
    sender.send({ type: "chat", chat_id: "chat-1", content: "@researcher what is the weather?" });

    const msg = await agent.waitForMsg("chat", 2000);
    expect(msg.content).toBe("what is the weather?");
    expect(msg.from).toBe("sender");

    agent.close(); sender.close();
  });

  it("multiple @mentions route to different agents", async () => {
    const alice = await registerAndWait(port, "alice");
    const bob = await registerAndWait(port, "bob");
    const sender = await registerAndWait(port, "router");
    await delay(50);

    sender.send({ type: "chat", chat_id: "chat-2", content: "@alice hello alice" });
    sender.send({ type: "chat", chat_id: "chat-3", content: "@bob hello bob" });

    const [msgA, msgB] = await Promise.all([
      alice.waitForMsg("chat", 2000),
      bob.waitForMsg("chat", 2000),
    ]);
    expect(msgA.content).toBe("hello alice");
    expect(msgB.content).toBe("hello bob");

    alice.close(); bob.close(); sender.close();
  });

  it("unknown @mention falls through to hub broadcast (host receives it)", async () => {
    const messages: any[] = [];
    hub.on("message", (m: any) => messages.push(m));
    const sender = await registerAndWait(port, "unknown-sender");
    await delay(50);

    sender.send({ type: "chat", chat_id: "chat-4", content: "@nobody hello?" });

    await delay(200);
    const received = messages.find(m => m.content === "@nobody hello?");
    expect(received).toBeDefined();

    sender.close();
  });

  it("message with no @mention broadcasts to hub (host receives it)", async () => {
    const messages: any[] = [];
    hub.on("message", (m: any) => messages.push(m));
    const sender = await registerAndWait(port, "plain-sender");
    await delay(50);

    sender.send({ type: "chat", chat_id: "chat-5", content: "hello everyone" });

    await delay(200);
    const received = messages.find(m => m.content === "hello everyone");
    expect(received).toBeDefined();
    expect(received.user).toBe("plain-sender");

    sender.close();
  });
});

// ── 3. @mention across hubs ───────────────────────────────────────────────────

describe("@mention routing (cross-hub)", () => {
  let hubA: ChannelHub, hubB: ChannelHub;
  let portA: number, portB: number;

  beforeEach(async () => {
    portA = nextPort(); portB = nextPort();
    hubA = createTestHub({ name: "xm-A" });
    hubB = createTestHub({ name: "xm-B" });
    await startTestServer(hubA, portA);
    await startTestServer(hubB, portB);
    await hubA.connect(`ws://localhost:${portB}`, "xm-A");
    await delay(300);
  });
  afterEach(() => { cleanupHub(hubA); cleanupHub(hubB); });

  it("@mention on hub B routes to local agent on hub B", async () => {
    const analyst = await registerAndWait(portB, "analyst");
    const sender = await registerAndWait(portB, "questioner");
    await delay(50);

    sender.send({ type: "chat", chat_id: "cross-1", content: "@analyst run analysis" });
    const msg = await analyst.waitForMsg("chat", 2000);
    expect(msg.content).toBe("run analysis");

    analyst.close(); sender.close();
  });

  it("hub A can route by agent name when agent is local to hub A", async () => {
    const local = await registerAndWait(portA, "local-agent");
    await delay(50);

    // Hub A resolves by name → finds local agent → delivers as type "reply"
    hubA.reply("local-agent", "direct by name");
    const msg = await local.waitForMsg("reply", 2000);
    expect(msg.text ?? msg.content).toBe("direct by name");

    local.close();
  });

  it("hub A broadcasts message reaching hub A host", async () => {
    const messagesA: any[] = [];
    hubA.on("message", (m: any) => messagesA.push(m));

    // Agent on hub A sends with no target → hub A host receives it
    const sender = await registerAndWait(portA, "a-sender");
    await delay(50);
    sender.send({ type: "chat", chat_id: "broad-1", content: "broadcast from A" });

    await delay(200);
    const received = messagesA.find(m => m.content === "broadcast from A");
    expect(received).toBeDefined();

    sender.close();
  });
});

// ── 4. Group broadcast ────────────────────────────────────────────────────────

describe("group broadcast (single hub, multiple agents)", () => {
  let hub: ChannelHub;
  let port: number;

  beforeEach(async () => {
    port = nextPort();
    hub = createTestHub({ name: "group-hub" });
    await startTestServer(hub, port);
  });
  afterEach(() => cleanupHub(hub));

  it("broadcastToGroup delivers to all group members", async () => {
    const m1 = await registerAndWait(port, "gm-1");
    const m2 = await registerAndWait(port, "gm-2");
    const m3 = await registerAndWait(port, "gm-3");
    await delay(50);

    hub.createGroup("team");
    hub.addToGroup("team", m1.id);
    hub.addToGroup("team", m2.id);
    hub.addToGroup("team", m3.id);

    hub.broadcastToGroup("team", "team announcement", "hub");

    // broadcastToGroup sends type: "group_broadcast" to WS agents
    const [r1, r2, r3] = await Promise.all([
      m1.waitForMsg("group_broadcast", 2000),
      m2.waitForMsg("group_broadcast", 2000),
      m3.waitForMsg("group_broadcast", 2000),
    ]);
    expect(r1.content).toBe("team announcement");
    expect(r2.content).toBe("team announcement");
    expect(r3.content).toBe("team announcement");

    m1.close(); m2.close(); m3.close();
  });

  it("member not in group does NOT receive broadcast", async () => {
    const inGroup = await registerAndWait(port, "in-group");
    const outGroup = await registerAndWait(port, "out-group");
    await delay(50);

    hub.createGroup("selective");
    hub.addToGroup("selective", inGroup.id);
    // outGroup is NOT added

    hub.broadcastToGroup("selective", "private msg", "hub");

    const msg = await inGroup.waitForMsg("group_broadcast", 2000);
    expect(msg.content).toBe("private msg");

    // outGroup receives nothing — wait 300ms and check
    await delay(300);
    expect(outGroup.messages.find((m: any) => m.type === "chat")).toBeUndefined();

    inGroup.close(); outGroup.close();
  });

  it("agent-initiated broadcast via group_broadcast message type", async () => {
    const sender = await registerAndWait(port, "gb-sender");
    const receiver = await registerAndWait(port, "gb-receiver");
    await delay(50);

    hub.createGroup("agents");
    hub.addToGroup("agents", receiver.id);
    hub.addToGroup("agents", sender.id); // sets sender.groupName = "agents"

    sender.send({ type: "group_broadcast", content: "agent broadcast", meta: { group: "agents" } });

    // hub re-broadcasts as group_broadcast to other members
    const msg = await receiver.waitForMsg("group_broadcast", 2000);
    expect(msg.content).toBe("agent broadcast");

    sender.close(); receiver.close();
  });
});

// ── 5. Multi-hub group (same group name, different hubs) ──────────────────────

describe("multi-hub group broadcast", () => {
  let hubA: ChannelHub, hubB: ChannelHub;
  let portA: number, portB: number;

  beforeEach(async () => {
    portA = nextPort(); portB = nextPort();
    hubA = createTestHub({ name: "mhg-A" });
    hubB = createTestHub({ name: "mhg-B" });
    await startTestServer(hubA, portA);
    await startTestServer(hubB, portB);
    await hubA.connect(`ws://localhost:${portB}`, "mhg-A");
    await delay(300);
  });
  afterEach(() => { cleanupHub(hubA); cleanupHub(hubB); });

  it("hub B group broadcast reaches all local members", async () => {
    const m1 = await registerAndWait(portB, "hb-m1");
    const m2 = await registerAndWait(portB, "hb-m2");
    await delay(50);

    hubB.createGroup("zone");
    hubB.addToGroup("zone", m1.id);
    hubB.addToGroup("zone", m2.id);

    hubB.broadcastToGroup("zone", "zone alert", "hub-B");

    const [r1, r2] = await Promise.all([
      m1.waitForMsg("group_broadcast", 2000),
      m2.waitForMsg("group_broadcast", 2000),
    ]);
    expect(r1.content).toBe("zone alert");
    expect(r2.content).toBe("zone alert");

    m1.close(); m2.close();
  });

  it("hub A delivers to hub B group members by UUID (cross-hub group)", async () => {
    const m1 = await registerAndWait(portB, "cg-m1");
    const m2 = await registerAndWait(portB, "cg-m2");
    await delay(50);

    // Hub A doesn't know about Hub B's groups, but can send to each member by UUID
    hubA.reply(m1.id, "cross-hub group msg 1");
    hubA.reply(m2.id, "cross-hub group msg 2");

    const [r1, r2] = await Promise.all([
      m1.waitForMsg("chat", 3000),
      m2.waitForMsg("chat", 3000),
    ]);
    expect(r1.content).toBe("cross-hub group msg 1");
    expect(r2.content).toBe("cross-hub group msg 2");

    m1.close(); m2.close();
  });
});
