/**
 * Message buffering for offline agents.
 *
 * When sendMessage() targets an agent that isn't currently connected,
 * the hub buffers the message (up to 100 per agent name). When the
 * agent reconnects, buffered messages are flushed automatically.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ChannelHub } from "../dist/index.js";
import { createTestHub, nextPort, delay, connectRawAgent } , startTestServer , startTestServer from "./helpers.js";

function cleanupHub(hub: ChannelHub) {
  (hub as any).stopHealthMonitor?.();
  for (const a of hub.agents.values()) try { a.ws?.close?.(); } catch {}
  for (const [, s] of hub.servers) { try { s.httpServer?.close(); s.wss?.close(); } catch {} }
}

describe("message buffering for offline agents", () => {
  let hub: ChannelHub;
  let port: number;

  beforeEach(async () => {
    port = nextPort();
    hub = createTestHub({ name: "buf-hub" });
    await startTestServer(hub, port);
  });
  afterEach(() => cleanupHub(hub));

  it("messages sent to unknown agent name are buffered and flushed on connect", async () => {
    // Send BEFORE the agent connects
    hub.sendMessage("late-agent", "buffered hello");
    hub.sendMessage("late-agent", "buffered world");

    // Now the agent connects
    const agent = await connectRawAgent(port, "late-agent");
    await agent.waitForMsg("register_ack");

    // Should receive a flush notification + 2 buffered messages
    const notice = await agent.waitForMsg("chat", 2000);
    expect(notice.content).toMatch(/2 buffered message/);

    const m1 = await agent.waitForMsg("chat", 2000);
    const m2 = await agent.waitForMsg("chat", 2000);
    const contents = [m1.content, m2.content];
    expect(contents).toContain("buffered hello");
    expect(contents).toContain("buffered world");

    agent.close();
  });

  it("reconnecting agent receives messages sent while offline", async () => {
    // First connect
    const agent1 = await connectRawAgent(port, "reconnector");
    await agent1.waitForMsg("register_ack");
    await delay(50);
    agent1.close(); // disconnect
    await delay(200);

    // Messages sent while offline
    hub.sendMessage("reconnector", "offline msg 1");
    hub.sendMessage("reconnector", "offline msg 2");

    // Reconnect
    const agent2 = await connectRawAgent(port, "reconnector");
    await agent2.waitForMsg("register_ack");

    const notice = await agent2.waitForMsg("chat", 2000);
    expect(notice.content).toMatch(/2 buffered message/);

    const m1 = await agent2.waitForMsg("chat", 2000);
    const m2 = await agent2.waitForMsg("chat", 2000);
    expect([m1.content, m2.content]).toContain("offline msg 1");
    expect([m1.content, m2.content]).toContain("offline msg 2");

    agent2.close();
  });

  it("bufferMessage() can be called directly with rich params", async () => {
    hub.bufferMessage("rich-agent", "rich buffered", "tester", { format: "markdown" } as any);

    const agent = await connectRawAgent(port, "rich-agent");
    await agent.waitForMsg("register_ack");

    await agent.waitForMsg("chat", 2000); // flush notice
    const msg = await agent.waitForMsg("chat", 2000);
    expect(msg.content).toBe("rich buffered");
    expect(msg.from).toBe("tester");

    agent.close();
  });

  it("agent with no buffered messages gets no flush on connect", async () => {
    const agent = await connectRawAgent(port, "clean-agent");
    await agent.waitForMsg("register_ack");
    await delay(300);

    // No chat messages at all
    expect(agent.messages.find((m: any) => m.type === "chat")).toBeUndefined();

    agent.close();
  });

  it("buffer cap: oldest messages are dropped when over 100", async () => {
    // Buffer 102 messages — first 2 should be dropped
    for (let i = 0; i < 102; i++) {
      hub.bufferMessage("capped-agent", `msg-${i}`, "system");
    }

    const agent = await connectRawAgent(port, "capped-agent");
    await agent.waitForMsg("register_ack");

    const notice = await agent.waitForMsg("chat", 2000);
    expect(notice.content).toMatch(/100 buffered message/);

    const messages: string[] = [];
    for (let i = 0; i < 100; i++) {
      const m = await agent.waitForMsg("chat", 2000);
      messages.push(m.content);
    }
    // msg-0 and msg-1 were dropped (oldest)
    expect(messages).not.toContain("msg-0");
    expect(messages).not.toContain("msg-1");
    expect(messages).toContain("msg-2");
    expect(messages).toContain("msg-101");

    agent.close();
  });
});
