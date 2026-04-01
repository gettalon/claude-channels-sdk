/**
 * Smart routing test suite.
 *
 * Tests @agent mention bypass and bot username stripping
 * in the hub's routeChat() function.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestHub, connectRawAgent, waitForEvent, delay, startTestServer } from "./helpers.js";
import type { ChannelHub } from "../dist/index.js";

// Use a unique port range to avoid collisions with other test files
let smartPortCounter = 19800;
function nextSmartPort(): number { return smartPortCounter++; }

let hub: ChannelHub;
let port: number;

describe("Smart Routing (@agent mention bypass)", () => {
  beforeEach(async () => {
    port = nextSmartPort();
    hub = createTestHub({ name: "smart-route-test", port });
    await startTestServer(hub, port);
  });

  afterEach(async () => {
    for (const agent of hub.agents.values()) {
      try { agent.ws.close(); } catch {}
    }
    for (const [, s] of hub.servers) {
      try { s.httpServer?.close(); s.wss?.close(); } catch {}
    }
    hub.stopHealthMonitor();
    await delay(100);
  });

  // ── @agent mention routes to correct agent ────────────────────────────

  it("@agent mention routes to correct agent", async () => {
    const agent = await connectRawAgent(port, "polymarket");
    const ack = await agent.waitForMsg("register_ack");
    expect(ack.status).toBe("ok");

    // Simulate a channel message with @polymarket mention
    (hub as any).routeChat({
      chatId: "chat-100",
      content: "@polymarket what are the odds?",
      from: "alice",
      source: "channel",
    });

    const msg = await agent.waitForMsg("chat");
    expect(msg.chat_id).toBe("chat-100");
    expect(msg.from).toBe("alice");
    expect(msg.content).toBe("what are the odds?");

    agent.close();
  });

  // ── Content is stripped of @agent prefix before delivery ──────────────

  it("content is stripped of @agent prefix before delivery", async () => {
    const agent = await connectRawAgent(port, "weather");
    await agent.waitForMsg("register_ack");

    (hub as any).routeChat({
      chatId: "chat-200",
      content: "@weather forecast for NYC",
      from: "bob",
      source: "channel",
    });

    const msg = await agent.waitForMsg("chat");
    expect(msg.content).toBe("forecast for NYC");
    // Should NOT contain the @weather prefix
    expect(msg.content).not.toContain("@weather");

    agent.close();
  });

  // ── Bot username is stripped from content ──────────────────────────────

  it("bot username is stripped from content", async () => {
    // Create hub with botUsername configured
    for (const [, s] of hub.servers) {
      try { s.httpServer?.close(); s.wss?.close(); } catch {}
    }
    hub.stopHealthMonitor();
    await delay(100);

    port = nextSmartPort();
    hub = createTestHub({ name: "bot-strip-test", port, botUsername: "HomeClaudeh_bot" } as any);
    await startTestServer(hub, port);

    const messageEvents: any[] = [];
    hub.on("message", (evt: any) => messageEvents.push(evt));

    // Simulate message with bot mention but no agent mention
    (hub as any).routeChat({
      chatId: "chat-300",
      content: "@HomeClaudeh_bot hello world",
      from: "carol",
      source: "channel",
    });

    // Should be emitted as a message event with stripped content
    await delay(50);
    expect(messageEvents.length).toBe(1);
    expect(messageEvents[0].content).toBe("hello world");
  });

  // ── Unknown @agent falls through to normal routing ────────────────────

  it("unknown @agent falls through to normal routing", async () => {
    const messageEvents: any[] = [];
    hub.on("message", (evt: any) => messageEvents.push(evt));

    // No agent named "nonexistent" is registered
    (hub as any).routeChat({
      chatId: "chat-400",
      content: "@nonexistent do something",
      from: "dave",
      source: "channel",
    });

    // Should fall through to broadcast (emitMessage), not get stuck
    await delay(50);
    expect(messageEvents.length).toBe(1);
    // Content is unchanged since the @mention didn't match a known agent
    expect(messageEvents[0].content).toBe("@nonexistent do something");
  });

  // ── Auto-handover is set up for replies ───────────────────────────────

  it("auto-handover is set up for replies", async () => {
    const agent = await connectRawAgent(port, "assistant");
    const ack = await agent.waitForMsg("register_ack");
    expect(ack.status).toBe("ok");
    const agentId = ack.agent_id;

    // Before smart route, no chatRoute should exist
    expect(hub.chatRoutes.has("chat-500")).toBe(false);

    (hub as any).routeChat({
      chatId: "chat-500",
      content: "@assistant help me",
      from: "eve",
      source: "channel",
    });

    await agent.waitForMsg("chat");

    // After smart route, a chatRoute should be set up
    expect(hub.chatRoutes.has("chat-500")).toBe(true);
    expect(hub.chatRoutes.get("chat-500")).toBe(agentId);

    agent.close();
  });

  // ── Works with "@BotName @agent message" ──────────────────────────────

  it("works with both bot mention and agent mention", async () => {
    // Create hub with botUsername configured
    for (const [, s] of hub.servers) {
      try { s.httpServer?.close(); s.wss?.close(); } catch {}
    }
    hub.stopHealthMonitor();
    await delay(100);

    port = nextSmartPort();
    hub = createTestHub({ name: "combo-test", port, botUsername: "MyBot" } as any);
    await startTestServer(hub, port);

    const agent = await connectRawAgent(port, "finance");
    const ack = await agent.waitForMsg("register_ack");
    expect(ack.status).toBe("ok");

    // Message has both bot mention and agent mention
    (hub as any).routeChat({
      chatId: "chat-600",
      content: "@MyBot @finance what is AAPL price?",
      from: "frank",
      source: "channel",
    });

    const msg = await agent.waitForMsg("chat");
    // Bot mention stripped, then @finance stripped
    expect(msg.content).toBe("what is AAPL price?");
    expect(msg.from).toBe("frank");
    expect(msg.chat_id).toBe("chat-600");

    agent.close();
  });

  // ── smartRoute event is emitted ───────────────────────────────────────

  it("emits smartRoute event with correct metadata", async () => {
    const agent = await connectRawAgent(port, "researcher");
    const ack = await agent.waitForMsg("register_ack");
    expect(ack.status).toBe("ok");
    const agentId = ack.agent_id;

    const smartRoutePromise = waitForEvent(hub, "smartRoute");

    (hub as any).routeChat({
      chatId: "chat-700",
      content: "@researcher find papers on AI",
      from: "grace",
      source: "channel",
    });

    const event = await smartRoutePromise;
    expect(event.chatId).toBe("chat-700");
    expect(event.agentName).toBe("researcher");
    expect(event.agentId).toBe(agentId);

    agent.close();
  });
});
