/**
 * Phase 1: Cross-hub group membership sync + sender key notifications.
 *
 * Feature A: When Hub A calls addToGroup/removeFromGroup, it propagates a
 *   group_sync message to connected hub peers so they maintain a local copy
 *   of the group state.
 *
 * Feature B: When an agent joins a group that already has WS members, the hub
 *   notifies existing members (group_member_joined) and the new joiner
 *   (group_members_list) so agents can initiate pairwise key exchange.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ChannelHub } from "../dist/index.js";
import { createTestHub, nextPort, delay, connectRawAgent } from "./helpers.js";

function cleanupHub(hub: ChannelHub) {
  (hub as any).stopHealthMonitor?.();
  for (const a of hub.agents.values()) try { a.ws?.close?.(); } catch {}
  for (const [, s] of hub.servers) { try { s.httpServer?.close(); s.wss?.close(); } catch {} }
  for (const [, c] of hub.clients) { try { c.ws?.close?.(); } catch {}; if (c.heartbeatTimer) clearInterval(c.heartbeatTimer); }
}

// ── Feature A: Cross-hub group sync ─────────────────────────────────────────

describe("cross-hub group sync (Feature A)", () => {
  let hubA: ChannelHub, hubB: ChannelHub;
  let portA: number, portB: number;

  beforeEach(async () => {
    portA = nextPort(); portB = nextPort();
    hubA = createTestHub({ name: "sync-A" });
    hubB = createTestHub({ name: "sync-B" });
    await hubA.startServer(portA);
    await hubB.startServer(portB);
    // Symmetric: both connect to each other so group broadcasts can flow both ways
    await hubA.connect(`ws://localhost:${portB}`, "sync-A");
    await hubB.connect(`ws://localhost:${portA}`, "sync-B");
    await delay(300);
  });
  afterEach(() => { cleanupHub(hubA); cleanupHub(hubB); });

  it("Hub B learns about a group member when Hub A calls addToGroup", async () => {
    const agA = await connectRawAgent(portA, "alice");
    const ackA = await agA.waitForMsg("register_ack");
    await delay(50);

    hubA.createGroup("team");
    hubA.addToGroup("team", ackA.agent_id);
    await delay(200);

    // Hub B should now have "team" group with alice's qualified name
    const groupOnB = hubB.groups.get("team");
    expect(groupOnB).toBeDefined();
    const memberKeys = [...(groupOnB?.keys() ?? [])];
    // The qualified name is "ws:alice"
    expect(memberKeys.some(k => k.includes("alice"))).toBe(true);

    agA.close();
  });

  it("Hub B removes member when Hub A calls removeFromGroup", async () => {
    const agA = await connectRawAgent(portA, "alice-r");
    const ackA = await agA.waitForMsg("register_ack");
    await delay(50);

    hubA.createGroup("removable");
    hubA.addToGroup("removable", ackA.agent_id);
    await delay(200);

    // Verify Hub B has the member
    expect(hubB.groups.get("removable")).toBeDefined();

    hubA.removeFromGroup("removable", "alice-r");
    await delay(200);

    // Hub B should have removed alice-r
    const groupOnB = hubB.groups.get("removable");
    const memberKeys = [...(groupOnB?.keys() ?? [])];
    expect(memberKeys.some(k => k.includes("alice-r"))).toBe(false);

    agA.close();
  });

  it("Hub B creates the group if it does not exist yet", async () => {
    const agA = await connectRawAgent(portA, "alice-new");
    const ackA = await agA.waitForMsg("register_ack");
    await delay(50);

    // Hub B has no "brand-new-group" yet
    expect(hubB.groups.has("brand-new-group")).toBe(false);

    hubA.createGroup("brand-new-group");
    hubA.addToGroup("brand-new-group", ackA.agent_id);
    await delay(200);

    expect(hubB.groups.has("brand-new-group")).toBe(true);

    agA.close();
  });

  it("agent on Hub B receives group_broadcast from Hub A via synced group", async () => {
    const agA = await connectRawAgent(portA, "broadcaster");
    const ackA = await agA.waitForMsg("register_ack");
    const agB = await connectRawAgent(portB, "listener");
    const ackB = await agB.waitForMsg("register_ack");
    await delay(100);

    hubA.createGroup("channel");
    hubA.addToGroup("channel", ackA.agent_id);       // local agent on A
    hubA.addToGroup("channel", ackB.agent_id);        // remote agent on B — bare UUID
    await delay(300);

    // Hub A broadcasts — should reach Hub B's agent
    hubA.broadcastToGroup("channel", "hello channel", "system");
    const msg = await agB.waitForMsg("chat", 3000);   // arrives as "chat" (cross-hub)
    expect(msg.content).toBe("hello channel");

    agA.close(); agB.close();
  });

  it("Hub B can broadcastToGroup and reach Hub A agents after sync", async () => {
    const agA = await connectRawAgent(portA, "hub-a-member");
    const ackA = await agA.waitForMsg("register_ack");
    const agB = await connectRawAgent(portB, "hub-b-member");
    const ackB = await agB.waitForMsg("register_ack");
    await delay(100);

    // Hub A creates group and adds both members
    hubA.createGroup("shared");
    hubA.addToGroup("shared", ackA.agent_id);
    hubA.addToGroup("shared", ackB.agent_id);
    await delay(300);

    // After sync Hub B also knows about "shared" group
    // Hub B broadcasts — should reach Hub A agent (via Hub B's synced group state)
    hubB.broadcastToGroup("shared", "from B side", "hub-b-member");

    const msg = await agA.waitForMsg("chat", 3000);
    expect(msg.content).toBe("from B side");

    agA.close(); agB.close();
  });
});

// ── Feature B: Sender key notifications on group join ───────────────────────

describe("sender key notifications on group join (Feature B)", () => {
  let hub: ChannelHub;
  let port: number;

  beforeEach(async () => {
    port = nextPort();
    hub = createTestHub({ name: "key-hub" });
    await hub.startServer(port);
  });
  afterEach(() => cleanupHub(hub));

  it("first member to join receives no group_members_list", async () => {
    const agA = await connectRawAgent(port, "alice-k");
    await agA.waitForMsg("register_ack");
    const aliceId = hub.agents.values().next().value!.id;

    hub.createGroup("keys");
    hub.addToGroup("keys", aliceId);
    await delay(300);

    expect(agA.messages.find((m: any) => m.type === "group_members_list")).toBeUndefined();
    agA.close();
  });

  it("second member receives group_members_list with first member", async () => {
    const agA = await connectRawAgent(port, "alice-k2");
    const ackA = await agA.waitForMsg("register_ack");
    const agB = await connectRawAgent(port, "bob-k2");
    const ackB = await agB.waitForMsg("register_ack");

    hub.createGroup("keys2");
    hub.addToGroup("keys2", ackA.agent_id);
    await delay(50);
    hub.addToGroup("keys2", ackB.agent_id);
    await delay(200);

    const msg = agB.messages.find((m: any) => m.type === "group_members_list");
    expect(msg).toBeDefined();
    expect(msg.group).toBe("keys2");
    expect(msg.members).toHaveLength(1);
    expect(msg.members[0].id).toBe(ackA.agent_id);
    expect(msg.members[0].name).toBe("alice-k2");

    agA.close(); agB.close();
  });

  it("existing member receives group_member_joined when second joins", async () => {
    const agA = await connectRawAgent(port, "alice-k3");
    const ackA = await agA.waitForMsg("register_ack");
    const agB = await connectRawAgent(port, "bob-k3");
    const ackB = await agB.waitForMsg("register_ack");

    hub.createGroup("keys3");
    hub.addToGroup("keys3", ackA.agent_id);
    await delay(50);
    hub.addToGroup("keys3", ackB.agent_id);
    await delay(200);

    const msg = agA.messages.find((m: any) => m.type === "group_member_joined");
    expect(msg).toBeDefined();
    expect(msg.group).toBe("keys3");
    expect(msg.memberId).toBe(ackB.agent_id);
    expect(msg.memberName).toBe("bob-k3");

    agA.close(); agB.close();
  });

  it("both existing members receive group_member_joined when third joins", async () => {
    const agA = await connectRawAgent(port, "alice-k4");
    const ackA = await agA.waitForMsg("register_ack");
    const agB = await connectRawAgent(port, "bob-k4");
    const ackB = await agB.waitForMsg("register_ack");
    const agC = await connectRawAgent(port, "carol-k4");
    const ackC = await agC.waitForMsg("register_ack");

    hub.createGroup("keys4");
    hub.addToGroup("keys4", ackA.agent_id);
    hub.addToGroup("keys4", ackB.agent_id);
    await delay(50);
    hub.addToGroup("keys4", ackC.agent_id);
    await delay(200);

    const msgA = agA.messages.find((m: any) => m.type === "group_member_joined" && m.memberName === "carol-k4");
    const msgB = agB.messages.find((m: any) => m.type === "group_member_joined" && m.memberName === "carol-k4");
    expect(msgA).toBeDefined();
    expect(msgB).toBeDefined();
    expect(msgA.memberId).toBe(ackC.agent_id);
    expect(msgB.memberId).toBe(ackC.agent_id);

    agA.close(); agB.close(); agC.close();
  });

  it("third member receives group_members_list with both existing members", async () => {
    const agA = await connectRawAgent(port, "alice-k5");
    const ackA = await agA.waitForMsg("register_ack");
    const agB = await connectRawAgent(port, "bob-k5");
    const ackB = await agB.waitForMsg("register_ack");
    const agC = await connectRawAgent(port, "carol-k5");
    const ackC = await agC.waitForMsg("register_ack");

    hub.createGroup("keys5");
    hub.addToGroup("keys5", ackA.agent_id);
    hub.addToGroup("keys5", ackB.agent_id);
    await delay(50);
    hub.addToGroup("keys5", ackC.agent_id);
    await delay(200);

    const msg = agC.messages.find((m: any) => m.type === "group_members_list");
    expect(msg).toBeDefined();
    expect(msg.group).toBe("keys5");
    expect(msg.members).toHaveLength(2);
    const ids = msg.members.map((m: any) => m.id);
    expect(ids).toContain(ackA.agent_id);
    expect(ids).toContain(ackB.agent_id);

    agA.close(); agB.close(); agC.close();
  });

  it("no notification for bare UUID (remote agent) members", async () => {
    const agA = await connectRawAgent(port, "alice-k6");
    const ackA = await agA.waitForMsg("register_ack");

    hub.createGroup("keys6");
    hub.addToGroup("keys6", ackA.agent_id);
    await delay(50);

    // Add a bare UUID (no local WS agent for it)
    hub.addToGroup("keys6", "remote-agent-uuid-no-ws");
    await delay(200);

    // alice should NOT get a group_member_joined for the bare UUID
    const notifications = agA.messages.filter((m: any) => m.type === "group_member_joined");
    expect(notifications).toHaveLength(0);

    agA.close();
  });
});

// ── Feature A+B combined: cross-hub join notification ───────────────────────

describe("cross-hub group join notification (A+B)", () => {
  let hubA: ChannelHub, hubB: ChannelHub;
  let portA: number, portB: number;

  beforeEach(async () => {
    portA = nextPort(); portB = nextPort();
    hubA = createTestHub({ name: "kx-A" });
    hubB = createTestHub({ name: "kx-B" });
    await hubA.startServer(portA);
    await hubB.startServer(portB);
    await hubA.connect(`ws://localhost:${portB}`, "kx-A");
    await delay(300);
  });
  afterEach(() => { cleanupHub(hubA); cleanupHub(hubB); });

  it("Hub B notifies local bob when group_sync arrives with existing member alice", async () => {
    const agA = await connectRawAgent(portA, "alice-kx");
    const ackA = await agA.waitForMsg("register_ack");
    const agB = await connectRawAgent(portB, "bob-kx");
    const ackB = await agB.waitForMsg("register_ack");
    await delay(100);

    // Hub A creates group, adds alice first, then bob's UUID
    hubA.createGroup("kx-team");
    hubA.addToGroup("kx-team", ackA.agent_id);
    await delay(200); // sync alice to Hub B

    // Now add bob (on Hub B) — this syncs to Hub B which should notify bob
    hubA.addToGroup("kx-team", ackB.agent_id);
    await delay(300);

    // Bob should receive group_members_list with alice
    const listMsg = agB.messages.find((m: any) => m.type === "group_members_list");
    expect(listMsg).toBeDefined();
    expect(listMsg.group).toBe("kx-team");
    expect(listMsg.members.some((m: any) => m.name === "alice-kx")).toBe(true);

    agA.close(); agB.close();
  });
});
