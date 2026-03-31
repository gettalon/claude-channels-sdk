/**
 * Symmetric hub mesh — all hubs connect to all others.
 *
 * In a symmetric 3-hub mesh (A↔B, A↔C, B↔C) every hub has "server" peers
 * for all other hubs, enabling full bidirectional cross-hub delivery.
 *
 * Contrast with the asymmetric topology in cross-hub-proxy.test.ts where
 * C has no outgoing connections and cannot proxy to A or B.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ChannelHub } from "../dist/index.js";
import { createTestHub, nextPort, delay, connectRawAgent } from "./helpers.js";

function cleanupHub(hub: ChannelHub) {
  (hub as any).stopHealthMonitor?.();
  for (const a of hub.agents.values()) try { a.ws?.close?.(); } catch {}
  for (const [, s] of hub.servers) { try { s.httpServer?.close(); s.wss?.close(); } catch {} }
  for (const [, c] of hub.clients) { try { c.ws?.close?.(); } catch {} if (c.heartbeatTimer) clearInterval(c.heartbeatTimer); }
}

async function reg(port: number, name: string) {
  const a = await connectRawAgent(port, name);
  const ack = await a.waitForMsg("register_ack");
  return { ...a, id: ack.agent_id as string };
}

describe("symmetric 3-hub mesh (all ↔ all)", () => {
  let hubA: ChannelHub, hubB: ChannelHub, hubC: ChannelHub;
  let portA: number, portB: number, portC: number;

  beforeEach(async () => {
    portA = nextPort(); portB = nextPort(); portC = nextPort();
    hubA = createTestHub({ name: "sym-A" });
    hubB = createTestHub({ name: "sym-B" });
    hubC = createTestHub({ name: "sym-C" });

    await hubA.startServer(portA);
    await hubB.startServer(portB);
    await hubC.startServer(portC);

    // Full symmetric mesh: every hub connects TO every other hub
    await hubA.connect(`ws://localhost:${portB}`, "sym-A");
    await hubA.connect(`ws://localhost:${portC}`, "sym-A");
    await hubB.connect(`ws://localhost:${portA}`, "sym-B");
    await hubB.connect(`ws://localhost:${portC}`, "sym-B");
    await hubC.connect(`ws://localhost:${portA}`, "sym-C");
    await hubC.connect(`ws://localhost:${portB}`, "sym-C");
    await delay(500);
  });

  afterEach(() => { cleanupHub(hubA); cleanupHub(hubB); cleanupHub(hubC); });

  it("A→B, A→C delivery", async () => {
    const agB = await reg(portB, "agB");
    const agC = await reg(portC, "agC");
    await delay(100);

    hubA.reply(agB.id, "A→B");
    hubA.reply(agC.id, "A→C");

    const [mB, mC] = await Promise.all([
      agB.waitForMsg("chat", 3000),
      agC.waitForMsg("chat", 3000),
    ]);
    expect(mB.content).toBe("A→B");
    expect(mC.content).toBe("A→C");

    agB.close(); agC.close();
  });

  it("B→A, B→C delivery", async () => {
    const agA = await reg(portA, "agA");
    const agC = await reg(portC, "agC2");
    await delay(100);

    hubB.reply(agA.id, "B→A");
    hubB.reply(agC.id, "B→C");

    const [mA, mC] = await Promise.all([
      agA.waitForMsg("chat", 3000),
      agC.waitForMsg("chat", 3000),
    ]);
    expect(mA.content).toBe("B→A");
    expect(mC.content).toBe("B→C");

    agA.close(); agC.close();
  });

  it("C→A, C→B delivery", async () => {
    const agA = await reg(portA, "agA2");
    const agB = await reg(portB, "agB2");
    await delay(100);

    hubC.reply(agA.id, "C→A");
    hubC.reply(agB.id, "C→B");

    const [mA, mB] = await Promise.all([
      agA.waitForMsg("chat", 3000),
      agB.waitForMsg("chat", 3000),
    ]);
    expect(mA.content).toBe("C→A");
    expect(mB.content).toBe("C→B");

    agA.close(); agB.close();
  });

  it("all 6 directions simultaneously", async () => {
    const agA = await reg(portA, "full-A");
    const agB = await reg(portB, "full-B");
    const agC = await reg(portC, "full-C");
    await delay(100);

    // Fire all 6 cross-hub pairs
    hubA.reply(agB.id, "A→B"); hubA.reply(agC.id, "A→C");
    hubB.reply(agA.id, "B→A"); hubB.reply(agC.id, "B→C");
    hubC.reply(agA.id, "C→A"); hubC.reply(agB.id, "C→B");

    const [mA1, mA2] = await Promise.all([agA.waitForMsg("chat", 3000), agA.waitForMsg("chat", 3000)]);
    const [mB1, mB2] = await Promise.all([agB.waitForMsg("chat", 3000), agB.waitForMsg("chat", 3000)]);
    const [mC1, mC2] = await Promise.all([agC.waitForMsg("chat", 3000), agC.waitForMsg("chat", 3000)]);

    expect([mA1.content, mA2.content].sort()).toEqual(["B→A", "C→A"]);
    expect([mB1.content, mB2.content].sort()).toEqual(["A→B", "C→B"]);
    expect([mC1.content, mC2.content].sort()).toEqual(["A→C", "B→C"]);

    agA.close(); agB.close(); agC.close();
  });

  it("multiple agents per hub, all directions", async () => {
    const a1 = await reg(portA, "a1"); const a2 = await reg(portA, "a2");
    const b1 = await reg(portB, "b1"); const b2 = await reg(portB, "b2");
    const c1 = await reg(portC, "c1"); const c2 = await reg(portC, "c2");
    await delay(100);

    // Each hub sends to 2 agents on each other hub
    hubA.reply(b1.id, "A→b1"); hubA.reply(b2.id, "A→b2");
    hubA.reply(c1.id, "A→c1"); hubA.reply(c2.id, "A→c2");
    hubB.reply(a1.id, "B→a1"); hubB.reply(a2.id, "B→a2");
    hubC.reply(a1.id, "C→a1"); hubC.reply(a2.id, "C→a2");

    const aMessages = await Promise.all([
      a1.waitForMsg("chat", 3000), a1.waitForMsg("chat", 3000),
      a2.waitForMsg("chat", 3000), a2.waitForMsg("chat", 3000),
    ]);
    const bMessages = await Promise.all([
      b1.waitForMsg("chat", 3000), b2.waitForMsg("chat", 3000),
    ]);
    const cMessages = await Promise.all([
      c1.waitForMsg("chat", 3000), c2.waitForMsg("chat", 3000),
    ]);

    const aContents = aMessages.map(m => m.content).sort();
    expect(aContents).toEqual(["B→a1", "B→a2", "C→a1", "C→a2"]);
    expect(bMessages.map(m => m.content).sort()).toEqual(["A→b1", "A→b2"]);
    expect(cMessages.map(m => m.content).sort()).toEqual(["A→c1", "A→c2"]);

    [a1,a2,b1,b2,c1,c2].forEach(a => a.close());
  });
});
