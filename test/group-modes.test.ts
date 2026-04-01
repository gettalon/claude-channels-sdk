/**
 * Group receive modes: "all" vs "@only"
 *
 * "all"   — member receives every group broadcast
 * "@only" — member receives only when @mentioned by name in the message
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ChannelHub } from "../dist/index.js";
import { createTestHub, nextPort, delay, connectRawAgent } , startTestServer , startTestServer from "./helpers.js";

function cleanupHub(hub: ChannelHub) {
  (hub as any).stopHealthMonitor?.();
  for (const a of hub.agents.values()) try { a.ws?.close?.(); } catch {}
  for (const [, s] of hub.servers) { try { s.httpServer?.close(); s.wss?.close(); } catch {} }
}

async function reg(port: number, name: string) {
  const a = await connectRawAgent(port, name);
  const ack = await a.waitForMsg("register_ack");
  return { ...a, id: ack.agent_id as string };
}

describe("group receive modes (@only vs all)", () => {
  let hub: ChannelHub;
  let port: number;

  beforeEach(async () => {
    port = nextPort();
    hub = createTestHub({ name: "mode-hub" });
    await startTestServer(hub, port);
  });
  afterEach(() => cleanupHub(hub));

  it('"all" member receives every broadcast', async () => {
    const m = await reg(port, "all-member");
    hub.createGroup("g");
    hub.addToGroup("g", m.id, "all");

    hub.broadcastToGroup("g", "hello group", "system");
    const msg = await m.waitForMsg("group_broadcast", 2000);
    expect(msg.content).toBe("hello group");

    m.close();
  });

  it('"@only" member receives only when @mentioned', async () => {
    const mentioned = await reg(port, "vip");
    const quiet = await reg(port, "lurker");
    hub.createGroup("g2");
    hub.addToGroup("g2", mentioned.id, "all");
    hub.addToGroup("g2", quiet.id, "@only"); // lurker only gets @lurker messages

    // Broadcast WITHOUT @lurker
    hub.broadcastToGroup("g2", "general announcement", "system");
    const vipMsg = await mentioned.waitForMsg("group_broadcast", 2000);
    expect(vipMsg.content).toBe("general announcement");

    // lurker should NOT receive it
    await delay(300);
    expect(quiet.messages.find((m: any) => m.type === "group_broadcast")).toBeUndefined();

    mentioned.close();
    quiet.close();
  });

  it('"@only" member receives when @mentioned by name', async () => {
    const always = await reg(port, "always");
    const targeted = await reg(port, "lurker2");
    hub.createGroup("g3");
    hub.addToGroup("g3", always.id, "all");
    hub.addToGroup("g3", targeted.id, "@only");

    // Broadcast WITH @lurker2 mention
    hub.broadcastToGroup("g3", "hey @lurker2 check this out", "system");

    const [msgA, msgT] = await Promise.all([
      always.waitForMsg("group_broadcast", 2000),
      targeted.waitForMsg("group_broadcast", 2000),
    ]);
    expect(msgA.content).toBe("hey @lurker2 check this out");
    expect(msgT.content).toBe("hey @lurker2 check this out");

    always.close();
    targeted.close();
  });

  it("sender is excluded from its own broadcast", async () => {
    const sender = await reg(port, "broadcaster");
    const receiver = await reg(port, "listener");
    hub.createGroup("g4");
    hub.addToGroup("g4", sender.id, "all");
    hub.addToGroup("g4", receiver.id, "all");

    hub.broadcastToGroup("g4", "self-sent", "broadcaster");

    const msg = await receiver.waitForMsg("group_broadcast", 2000);
    expect(msg.content).toBe("self-sent");

    // Sender should NOT receive its own broadcast
    await delay(300);
    expect(sender.messages.find((m: any) => m.type === "group_broadcast")).toBeUndefined();

    sender.close();
    receiver.close();
  });

  it("mixed group: some @only, some all — only matching members get each message", async () => {
    const always1 = await reg(port, "always1");
    const always2 = await reg(port, "always2");
    const atOnly = await reg(port, "notifier");
    hub.createGroup("mixed");
    hub.addToGroup("mixed", always1.id, "all");
    hub.addToGroup("mixed", always2.id, "all");
    hub.addToGroup("mixed", atOnly.id, "@only");

    // Message without @notifier — only "all" members receive
    hub.broadcastToGroup("mixed", "update for everyone", "system");
    const [m1, m2] = await Promise.all([
      always1.waitForMsg("group_broadcast", 2000),
      always2.waitForMsg("group_broadcast", 2000),
    ]);
    expect(m1.content).toBe("update for everyone");
    expect(m2.content).toBe("update for everyone");
    await delay(300);
    expect(atOnly.messages.find((m: any) => m.type === "group_broadcast")).toBeUndefined();

    // Message with @notifier — all three receive
    hub.broadcastToGroup("mixed", "@notifier action required", "system");
    const [ma, mb, mc] = await Promise.all([
      always1.waitForMsg("group_broadcast", 2000),
      always2.waitForMsg("group_broadcast", 2000),
      atOnly.waitForMsg("group_broadcast", 2000),
    ]);
    expect(ma.content).toBe("@notifier action required");
    expect(mb.content).toBe("@notifier action required");
    expect(mc.content).toBe("@notifier action required");

    always1.close(); always2.close(); atOnly.close();
  });

  it("agent-initiated group_broadcast respects @only mode", async () => {
    const sender = await reg(port, "ag-sender");
    const rcvAll = await reg(port, "ag-all");
    const rcvOnly = await reg(port, "ag-only");
    hub.createGroup("agent-grp");
    hub.addToGroup("agent-grp", sender.id);      // "all"
    hub.addToGroup("agent-grp", rcvAll.id, "all");
    hub.addToGroup("agent-grp", rcvOnly.id, "@only");

    // Agent sends without @ag-only mention
    sender.send({ type: "group_broadcast", content: "no mention", meta: { group: "agent-grp" } });

    const msg = await rcvAll.waitForMsg("group_broadcast", 2000);
    expect(msg.content).toBe("no mention");
    await delay(300);
    expect(rcvOnly.messages.find((m: any) => m.type === "group_broadcast")).toBeUndefined();

    // Agent sends with @ag-only mention
    sender.send({ type: "group_broadcast", content: "@ag-only ping", meta: { group: "agent-grp" } });
    const [msgAll, msgOnly] = await Promise.all([
      rcvAll.waitForMsg("group_broadcast", 2000),
      rcvOnly.waitForMsg("group_broadcast", 2000),
    ]);
    expect(msgAll.content).toBe("@ag-only ping");
    expect(msgOnly.content).toBe("@ag-only ping");

    sender.close(); rcvAll.close(); rcvOnly.close();
  });
});
