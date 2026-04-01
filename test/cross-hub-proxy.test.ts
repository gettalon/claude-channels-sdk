/**
 * Cross-hub message proxy tests.
 *
 * When Hub A has a hub-to-hub connection to Hub B, and an agent is registered on Hub B,
 * Hub A should be able to deliver a message to that agent by forwarding it to Hub B.
 *
 * Also covers 3-hub full-mesh: Hub A connected to Hub B and Hub C. Messages targeted
 * at agents on Hub C should reach Hub C even though Hub A lists Hub B first.
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
    try { s.httpServer?.close(); } catch {}
    try { s.wss?.close(); } catch {}
  }
  for (const [, c] of hub.clients) {
    try { c.ws?.close?.(); } catch {}
    if (c.heartbeatTimer) clearInterval(c.heartbeatTimer);
  }
}

// ── 1. Two-hub proxy (A→B) ────────────────────────────────────────────────────

describe("cross-hub message proxy (two hubs)", () => {
  let hubA: ChannelHub;
  let hubB: ChannelHub;
  let portA: number;
  let portB: number;

  beforeEach(async () => {
    portA = nextPort();
    portB = nextPort();
    hubA = createTestHub({ name: "proxy-A", port: portA });
    hubB = createTestHub({ name: "proxy-B", port: portB });

    await startTestServer(hubA, portA);
    await startTestServer(hubB, portB);
    // Hub A connects to Hub B as a client
    await hubA.connect(`ws://localhost:${portB}`, "proxy-A");
    await delay(300);
  });

  afterEach(() => {
    cleanupHub(hubA);
    cleanupHub(hubB);
  });

  it("hub A reply() to agent UUID on hub B delivers the message", async () => {
    const agentB = await connectRawAgent(portB, "agent-on-B");
    const ack = await agentB.waitForMsg("register_ack");
    expect(ack.status).toBe("ok");
    const agentBId = ack.agent_id;
    await delay(100);

    const result = hubA.reply(agentBId, "hello from A to agent on B");
    expect(result.ok).toBe(true);

    const msg = await agentB.waitForMsg("chat", 3000);
    expect(msg.content).toBe("hello from A to agent on B");

    agentB.close();
  });

  it("hub A sendMessage() to agent UUID on hub B delivers the message", async () => {
    const agentB = await connectRawAgent(portB, "agent-on-B-2");
    const ack = await agentB.waitForMsg("register_ack");
    expect(ack.status).toBe("ok");
    const agentBId = ack.agent_id;
    await delay(100);

    const result = hubA.sendMessage(agentBId, "sendMessage from A to agent on B");
    expect(result.ok).toBe(true);

    const msg = await agentB.waitForMsg("chat", 3000);
    expect(msg.content).toBe("sendMessage from A to agent on B");

    agentB.close();
  });
});

// ── 2. Three-hub full mesh (A→B and A→C) ─────────────────────────────────────

describe("cross-hub message proxy (three-hub mesh)", () => {
  let hubA: ChannelHub;
  let hubB: ChannelHub;
  let hubC: ChannelHub;
  let portA: number;
  let portB: number;
  let portC: number;

  beforeEach(async () => {
    portA = nextPort();
    portB = nextPort();
    portC = nextPort();
    hubA = createTestHub({ name: "mesh-A", port: portA });
    hubB = createTestHub({ name: "mesh-B", port: portB });
    hubC = createTestHub({ name: "mesh-C", port: portC });

    await startTestServer(hubA, portA);
    await startTestServer(hubB, portB);
    await startTestServer(hubC, portC);

    // Full mesh: A connects to B and C; B connects to C
    await hubA.connect(`ws://localhost:${portB}`, "mesh-A");
    await hubA.connect(`ws://localhost:${portC}`, "mesh-A");
    await hubB.connect(`ws://localhost:${portC}`, "mesh-B");
    await delay(400);
  });

  afterEach(() => {
    cleanupHub(hubA);
    cleanupHub(hubB);
    cleanupHub(hubC);
  });

  it("hub A delivers to agent on hub B (first connection)", async () => {
    const agentB = await connectRawAgent(portB, "agent-B");
    const ackB = await agentB.waitForMsg("register_ack");
    const agentBId = ackB.agent_id;
    await delay(100);

    hubA.reply(agentBId, "A→B delivery");
    const msg = await agentB.waitForMsg("chat", 3000);
    expect(msg.content).toBe("A→B delivery");

    agentB.close();
  });

  it("hub A delivers to agent on hub C (second connection)", async () => {
    const agentC = await connectRawAgent(portC, "agent-C");
    const ackC = await agentC.waitForMsg("register_ack");
    const agentCId = ackC.agent_id;
    await delay(100);

    hubA.reply(agentCId, "A→C delivery");
    const msg = await agentC.waitForMsg("chat", 3000);
    expect(msg.content).toBe("A→C delivery");

    agentC.close();
  });

  it("hub B delivers to agent on hub C (via direct connection)", async () => {
    const agentC = await connectRawAgent(portC, "agent-C-2");
    const ackC = await agentC.waitForMsg("register_ack");
    const agentCId = ackC.agent_id;
    await delay(100);

    hubB.reply(agentCId, "B→C delivery");
    const msg = await agentC.waitForMsg("chat", 3000);
    expect(msg.content).toBe("B→C delivery");

    agentC.close();
  });

  it("hub A delivers to both B and C agents simultaneously", async () => {
    // Topology: A→B, A→C, B→C (A has server peers B and C; B has server peer C; C has none)
    // Works: A→B, A→C, B→C
    const agentB = await connectRawAgent(portB, "agent-B-s");
    const agentC = await connectRawAgent(portC, "agent-C-s");
    const ackB = await agentB.waitForMsg("register_ack");
    const ackC = await agentC.waitForMsg("register_ack");
    await delay(100);

    // A floods both peers: B gets A→B (matching), C gets A→B (no agent, drops)
    hubA.reply(ackB.agent_id, "A→B");
    // A floods both peers: B gets A→C (no agent, drops), C gets A→C (matching)
    hubA.reply(ackC.agent_id, "A→C");
    // B→C: B has C as server peer, C delivers directly
    hubB.reply(ackC.agent_id, "B→C");

    const [msgB] = await Promise.all([agentB.waitForMsg("chat", 3000)]);
    const [msgC1, msgC2] = await Promise.all([
      agentC.waitForMsg("chat", 3000),
      agentC.waitForMsg("chat", 3000),
    ]);

    expect(msgB.content).toBe("A→B");
    const cContents = [msgC1.content, msgC2.content].sort();
    expect(cContents).toEqual(["A→C", "B→C"]);

    agentB.close();
    agentC.close();
  });
});
