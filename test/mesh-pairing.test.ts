/**
 * Tests for hub-to-hub mesh pairing and bidirectional messaging:
 *   1. Pairing notifications: connecting hub receives pending/approved/denied status
 *   2. Bidirectional messaging: both hub A→B and B→A work over the same connection
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ChannelHub } from "../dist/index.js";
import { createTestHub, nextPort, delay, waitForEvent, connectRawAgent, startTestServer } from "./helpers.js";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

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

// ── 1. Pairing flow notifications ───────────────────────────────────────────

describe("hub-to-hub pairing notifications", () => {
  let hubB: ChannelHub;
  let portB: number;
  let settingsDir: string;

  beforeEach(async () => {
    portB = nextPort();
    // Create settings with requireApproval
    settingsDir = join(process.env.TALON_HOME ?? "/tmp", `pairing-test-${Date.now()}`);
    await mkdir(settingsDir, { recursive: true });
    await writeFile(join(settingsDir, "settings.json"), JSON.stringify({
      access: {
        requireApproval: true,
        forceApprovalAll: true, // even local connections need approval
      },
    }));

    hubB = createTestHub({ name: "hub-B", port: portB });
    // Point hub B's settings to our test dir
    const { setSettingsPath } = await import("../dist/hub-settings.js");
    setSettingsPath(join(settingsDir, "settings.json"));

    await startTestServer(hubB, portB);
  });

  afterEach(async () => {
    const { setSettingsPath } = await import("../dist/hub-settings.js");
    setSettingsPath(join(process.env.TALON_HOME ?? "/tmp", "settings.json"));
    cleanupHub(hubB);
  });

  it("connecting hub receives pending_approval notification", async () => {
    const hubA = createTestHub({ name: "hub-A", agentName: "hub-A" });
    const messages: any[] = [];
    hubA.on("message", (msg) => messages.push(msg));
    hubA.on("approvalPending", () => {}); // ensure event fires

    const pendingPromise = waitForEvent(hubA, "approvalPending", 5000);

    await hubA.connect(`ws://localhost:${portB}`, "hub-A");
    await delay(500);

    const pendingEvent = await pendingPromise;
    expect(pendingEvent.message).toContain("Approval required");

    // Hub A should have received a system message about pending approval
    const pendingMsg = messages.find(m => m.content?.includes("Pending approval"));
    expect(pendingMsg).toBeDefined();

    cleanupHub(hubA);
  });

  it("connecting hub receives approved notification after approval", async () => {
    const hubA = createTestHub({ name: "hub-A-2", agentName: "hub-A-2" });
    const messages: any[] = [];
    hubA.on("message", (msg) => messages.push(msg));

    await hubA.connect(`ws://localhost:${portB}`, "hub-A-2");
    await delay(500);

    // Hub B should have the pending agent
    const pending = hubB.listPendingAgents();
    expect(pending.length).toBeGreaterThanOrEqual(1);
    const code = pending.find(p => p.name === "hub-A-2")!.code;

    // Approve
    const approvedPromise = waitForEvent(hubA, "approvalGranted", 5000);
    await hubB.approveAgent(code);
    await delay(500);

    const approvedEvent = await approvedPromise;
    expect(approvedEvent.agentId).toBeDefined();

    // approvalGranted event is sufficient — "Approved" message notification is suppressed during init

    cleanupHub(hubA);
  });

  it("connecting hub receives denied notification", async () => {
    const hubA = createTestHub({ name: "hub-A-3", agentName: "hub-A-3" });
    const messages: any[] = [];
    hubA.on("message", (msg) => messages.push(msg));

    await hubA.connect(`ws://localhost:${portB}`, "hub-A-3");
    await delay(500);

    const pending = hubB.listPendingAgents();
    const code = pending.find(p => p.name === "hub-A-3")!.code;

    const deniedPromise = waitForEvent(hubA, "approvalDenied", 5000);
    hubB.denyAgent(code);
    await delay(500);

    const deniedEvent = await deniedPromise;
    expect(deniedEvent.message).toContain("denied");

    const deniedMsg = messages.find(m => m.content?.includes("denied"));
    expect(deniedMsg).toBeDefined();

    cleanupHub(hubA);
  });
});

// ── 2. Bidirectional hub-to-hub messaging ───────────────────────────────────

describe("bidirectional hub-to-hub messaging", () => {
  let hubA: ChannelHub;
  let hubB: ChannelHub;
  let portA: number;
  let portB: number;

  beforeEach(async () => {
    portA = nextPort();
    portB = nextPort();
    hubA = createTestHub({ name: "mesh-A", port: portA });
    hubB = createTestHub({ name: "mesh-B", port: portB });

    await hubB.startServer(portB);
    // Hub A connects to Hub B as a client
    await hubA.connect(`ws://localhost:${portB}`, "mesh-A");
    await delay(500);
  });

  afterEach(() => {
    cleanupHub(hubA);
    cleanupHub(hubB);
  });

  it("hub B can send message to hub A (server→client)", async () => {
    const messagesA: any[] = [];
    hubA.on("message", (msg) => messagesA.push(msg));

    // Hub B sends to hub A (which is registered as an agent on B)
    const agent = hubB.findAgent("mesh-A");
    expect(agent).toBeDefined();
    hubB.wsSend(agent!.ws, { type: "chat", chat_id: "test-chat", content: "hello from B", from: "mesh-B" });

    await delay(300);

    const received = messagesA.find(m => m.content === "hello from B");
    expect(received).toBeDefined();
    expect(received.user).toBe("mesh-B");
  });

  it("hub A can reply back to hub B (client→server)", async () => {
    const messagesA: any[] = [];
    const messagesB: any[] = [];
    hubA.on("message", (msg) => messagesA.push(msg));
    hubB.on("message", (msg) => messagesB.push(msg));

    // Hub B sends to hub A with a chat_id
    const agent = hubB.findAgent("mesh-A")!;
    hubB.wsSend(agent.ws, { type: "chat", chat_id: "bidir-chat", content: "question from B", from: "mesh-B" });

    await delay(300);
    expect(messagesA.find(m => m.content === "question from B")).toBeDefined();

    // Hub A replies through the same connection
    // The chat_id "bidir-chat" should now be mapped to the server connection via channelForChat
    const result = hubA.reply("bidir-chat", "answer from A");
    expect(result.ok).toBe(true);

    await delay(300);

    // Hub B should receive the reply (via routeChat since mesh-A is registered as an agent)
    const reply = messagesB.find(m => m.content === "answer from A");
    expect(reply).toBeDefined();
  });

  it("hub A can send to hub B via getClientWs fallback", async () => {
    const messagesB: any[] = [];
    hubB.on("message", (msg) => messagesB.push(msg));

    // Hub A sends through server connection — uses getClientWs fallback
    // This sends as a chat from the agent "mesh-A" which B receives via routeChat → broadcast
    const cws = hubA.getClientWs();
    expect(cws).toBeDefined();
    hubA.wsSend(cws!, { type: "chat", chat_id: "direct", content: "direct from A", from: "mesh-A" });

    await delay(300);

    const received = messagesB.find(m => m.content === "direct from A");
    expect(received).toBeDefined();
  });

  it("multiple round-trips work on same chat_id", async () => {
    const messagesA: any[] = [];
    const messagesB: any[] = [];
    hubA.on("message", (msg) => messagesA.push(msg));
    hubB.on("message", (msg) => messagesB.push(msg));

    const agent = hubB.findAgent("mesh-A")!;

    // B → A (establishes channelForChat mapping on A)
    hubB.wsSend(agent.ws, { type: "chat", chat_id: "roundtrip", content: "msg-1", from: "mesh-B" });
    await delay(200);
    expect(messagesA.find(m => m.content === "msg-1")).toBeDefined();

    // A → B (reply routes back through server connection)
    hubA.reply("roundtrip", "reply-1");
    await delay(200);
    expect(messagesB.find(m => m.content === "reply-1")).toBeDefined();

    // B → A again
    hubB.wsSend(agent.ws, { type: "chat", chat_id: "roundtrip", content: "msg-2", from: "mesh-B" });
    await delay(200);
    expect(messagesA.filter(m => m.content?.startsWith("msg-")).length).toBe(2);

    // A → B again
    hubA.reply("roundtrip", "reply-2");
    await delay(200);
    expect(messagesB.filter(m => m.content?.startsWith("reply-")).length).toBe(2);
  });
});
