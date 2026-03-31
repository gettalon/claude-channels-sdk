/**
 * Flood deduplication: hub drops messages already seen by msgId.
 *
 * Without deduplication, any hub that re-floods a proxied message
 * would cause the target agent to receive it multiple times.
 * The seen-set (keyed by msgId) provides the structural guarantee
 * that prevents this — making the safety property explicit rather
 * than accidental.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ChannelHub } from "../dist/index.js";
import { createTestHub, nextPort, delay, connectRawAgent } from "./helpers.js";

function cleanupHub(hub: ChannelHub) {
  (hub as any).stopHealthMonitor?.();
  for (const a of hub.agents.values()) try { a.ws?.close?.(); } catch {}
  for (const [, s] of hub.servers) { try { s.httpServer?.close(); s.wss?.close(); } catch {} }
}

describe("flood deduplication (msgId seen-set)", () => {
  let hub: ChannelHub;
  let port: number;

  beforeEach(async () => {
    port = nextPort();
    hub = createTestHub({ name: "dedup-hub" });
    await hub.startServer(port);
  });
  afterEach(() => cleanupHub(hub));

  it("duplicate chat message with same msgId is delivered only once", async () => {
    // Target agent connects
    const agent = await connectRawAgent(port, "target-agent");
    const ack = await agent.waitForMsg("register_ack");
    const agentId = ack.agent_id as string;

    // Simulate a hub peer sending the same message twice (same msgId = reflood duplicate)
    const peer = await connectRawAgent(port, "hub-peer");
    await peer.waitForMsg("register_ack");

    const msgId = "test-dedup-id-001";
    const payload = { type: "chat", target: agentId, content: "dedup me", from: "remote-hub", msgId };

    peer.send(payload);
    peer.send(payload); // exact duplicate — should be dropped

    // Give hub time to deliver both (if not deduped) or just one (if deduped)
    await delay(300);

    const received = agent.messages.filter((m: any) => m.type === "chat" && m.content === "dedup me");
    expect(received).toHaveLength(1);

    agent.close();
    peer.close();
  });

  it("two messages with different msgIds are both delivered", async () => {
    const agent = await connectRawAgent(port, "target-agent-2");
    const ack2 = await agent.waitForMsg("register_ack");
    const agentId = ack2.agent_id as string;

    const peer = await connectRawAgent(port, "hub-peer-2");
    await peer.waitForMsg("register_ack");

    peer.send({ type: "chat", target: agentId, content: "msg-1", from: "remote-hub", msgId: "id-aaa" });
    peer.send({ type: "chat", target: agentId, content: "msg-2", from: "remote-hub", msgId: "id-bbb" });

    await delay(300);

    const received = agent.messages.filter((m: any) => m.type === "chat");
    expect(received).toHaveLength(2);

    agent.close();
    peer.close();
  });

  it("message without msgId is always delivered (backward compatibility)", async () => {
    const agent = await connectRawAgent(port, "target-agent-3");
    const ack3 = await agent.waitForMsg("register_ack");
    const agentId = ack3.agent_id as string;

    const peer = await connectRawAgent(port, "hub-peer-3");
    await peer.waitForMsg("register_ack");

    // No msgId field — should pass through as before
    peer.send({ type: "chat", target: agentId, content: "no-msgid", from: "remote-hub" });
    peer.send({ type: "chat", target: agentId, content: "no-msgid", from: "remote-hub" });

    await delay(300);

    // Without msgId, hub cannot dedup — both get through (backward compat)
    const received = agent.messages.filter((m: any) => m.type === "chat" && m.content === "no-msgid");
    expect(received).toHaveLength(2);

    agent.close();
    peer.close();
  });

  it("reply() flood stamps a msgId on outgoing proxied messages", async () => {
    // Connect a second hub as server peer
    const portB = nextPort();
    const hubB = createTestHub({ name: "dedup-B" });
    await hubB.startServer(portB);

    // Register an agent on hubB
    const agB = await connectRawAgent(portB, "agent-B");
    const ackB = await agB.waitForMsg("register_ack");
    const agBId = ackB.agent_id as string;

    // hub connects to hubB as client (hub is "client", hubB is "server" from hub's perspective)
    await hub.connect(`ws://localhost:${portB}`, "dedup-hub");
    await delay(300);

    // Capture outgoing messages from hub to hubB
    // The agent on hubB should receive exactly one message
    hub.reply(agBId, "proxy this");

    const msg = await agB.waitForMsg("chat", 2000);
    expect(msg.content).toBe("proxy this");
    // The forwarded message should carry a msgId
    expect(msg.msgId).toBeDefined();
    expect(typeof msg.msgId).toBe("string");
    expect(msg.msgId.length).toBeGreaterThan(0);

    agB.close();
    for (const a of hubB.agents.values()) try { a.ws?.close?.(); } catch {}
    for (const [, s] of hubB.servers) { try { s.httpServer?.close(); s.wss?.close(); } catch {} }
    for (const [, c] of hubB.clients) { try { c.ws?.close?.(); } catch {}; if (c.heartbeatTimer) clearInterval(c.heartbeatTimer); }
  });

  it("symmetric 3-hub mesh: agent receives cross-hub message exactly once", async () => {
    const portB = nextPort();
    const portC = nextPort();
    const hubB = createTestHub({ name: "sym-dedup-B" });
    const hubC = createTestHub({ name: "sym-dedup-C" });
    await hubB.startServer(portB);
    await hubC.startServer(portC);

    // Full symmetric mesh
    await hub.connect(`ws://localhost:${portB}`, "sym-dedup-A");
    await hub.connect(`ws://localhost:${portC}`, "sym-dedup-A");
    await hubB.connect(`ws://localhost:${port}`, "sym-dedup-B");
    await hubB.connect(`ws://localhost:${portC}`, "sym-dedup-B");
    await hubC.connect(`ws://localhost:${port}`, "sym-dedup-C");
    await hubC.connect(`ws://localhost:${portB}`, "sym-dedup-C");
    await delay(500);

    // Agent on hubC
    const agC = await connectRawAgent(portC, "sym-agent-C");
    const ackC = await agC.waitForMsg("register_ack");
    const agCId = ackC.agent_id as string;
    await delay(100);

    // Hub A sends to agC — floods hubB AND hubC
    // hubB receives with target=agCId, cannot deliver locally, should NOT re-flood
    // hubC receives with target=agCId, delivers directly
    // Result: agC should receive exactly 1 message
    hub.reply(agCId, "exactly-once");

    await delay(500);

    const received = agC.messages.filter((m: any) => m.type === "chat" && m.content === "exactly-once");
    expect(received).toHaveLength(1);

    agC.close();
    for (const h of [hubB, hubC]) {
      (h as any).stopHealthMonitor?.();
      for (const a of h.agents.values()) try { a.ws?.close?.(); } catch {}
      for (const [, s] of h.servers) { try { s.httpServer?.close(); s.wss?.close(); } catch {} }
      for (const [, c] of h.clients) { try { c.ws?.close?.(); } catch {}; if (c.heartbeatTimer) clearInterval(c.heartbeatTimer); }
    }
  });
});
