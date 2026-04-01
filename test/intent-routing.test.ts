/**
 * Intent-based routing test suite.
 *
 * Tests auto-detection of which agent should handle a message
 * based on content keywords/intents, not just @mention.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestHub, connectRawAgent, waitForEvent, delay } , startTestServer , startTestServer from "./helpers.js";
import type { ChannelHub } from "../dist/index.js";

// Use a unique port range to avoid collisions with other test files
let intentPortCounter = 19900;
function nextIntentPort(): number { return intentPortCounter++; }

let hub: ChannelHub;
let port: number;

/** Connect a raw agent with metadata (including intents). */
async function connectAgentWithIntents(
  port: number,
  agentName: string,
  intents: string[],
  tools: any[] = [],
): Promise<{
  ws: any;
  send: (msg: any) => void;
  waitForMsg: (type: string, timeoutMs?: number) => Promise<any>;
  messages: any[];
  close: () => void;
}> {
  const { default: WebSocket } = await import("ws");
  const ws = new WebSocket(`ws://localhost:${port}`);
  const messages: any[] = [];

  await new Promise<void>((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
  });

  ws.on("message", (data: Buffer) => {
    try { messages.push(JSON.parse(data.toString())); } catch {}
  });

  const send = (msg: any) => ws.send(JSON.stringify(msg));
  const waitForMsg = (type: string, timeoutMs = 5000): Promise<any> => {
    return new Promise((resolve, reject) => {
      const existing = messages.find((m) => m.type === type);
      if (existing) {
        messages.splice(messages.indexOf(existing), 1);
        return resolve(existing);
      }
      const timer = setTimeout(() => reject(new Error(`Timeout waiting for message type "${type}"`)), timeoutMs);
      const check = setInterval(() => {
        const found = messages.find((m) => m.type === type);
        if (found) {
          clearInterval(check);
          clearTimeout(timer);
          messages.splice(messages.indexOf(found), 1);
          resolve(found);
        }
      }, 50);
    });
  };

  // Register the agent with metadata containing intents
  send({ type: "register", agent_name: agentName, tools, metadata: { intents } });

  return { ws, send, waitForMsg, messages, close: () => ws.close() };
}

describe("Intent-based Routing", () => {
  beforeEach(async () => {
    port = nextIntentPort();
    hub = createTestHub({ name: "intent-route-test", port });
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

  // ── Single agent keyword match ────────────────────────────────────────

  it("routes to agent when message contains a matching intent keyword", async () => {
    const agent = await connectAgentWithIntents(port, "dexter", ["stock", "earnings", "NVDA", "AAPL"]);
    const ack = await agent.waitForMsg("register_ack");
    expect(ack.status).toBe("ok");

    (hub as any).routeChat({
      chatId: "intent-100",
      content: "What are NVDA earnings this quarter?",
      from: "alice",
      source: "channel",
    });

    const msg = await agent.waitForMsg("chat");
    expect(msg.chat_id).toBe("intent-100");
    expect(msg.from).toBe("alice");
    // Content is delivered unmodified (no stripping for intent routes)
    expect(msg.content).toBe("What are NVDA earnings this quarter?");

    agent.close();
  });

  // ── Case-insensitive matching ─────────────────────────────────────────

  it("matches intents case-insensitively", async () => {
    const agent = await connectAgentWithIntents(port, "finance", ["stock", "portfolio"]);
    const ack = await agent.waitForMsg("register_ack");
    expect(ack.status).toBe("ok");

    (hub as any).routeChat({
      chatId: "intent-200",
      content: "Show me my PORTFOLIO",
      from: "bob",
      source: "channel",
    });

    const msg = await agent.waitForMsg("chat");
    expect(msg.chat_id).toBe("intent-200");
    expect(msg.content).toBe("Show me my PORTFOLIO");

    agent.close();
  });

  // ── Multiple agents: highest score wins ───────────────────────────────

  it("picks agent with most keyword matches when multiple agents match", async () => {
    const agentA = await connectAgentWithIntents(port, "general", ["stock"]);
    const ackA = await agentA.waitForMsg("register_ack");
    expect(ackA.status).toBe("ok");

    const agentB = await connectAgentWithIntents(port, "specialist", ["stock", "earnings", "NVDA"]);
    const ackB = await agentB.waitForMsg("register_ack");
    expect(ackB.status).toBe("ok");

    (hub as any).routeChat({
      chatId: "intent-300",
      content: "NVDA stock earnings report?",
      from: "carol",
      source: "channel",
    });

    // Specialist should win with 3 matches (NVDA, stock, earnings) vs general's 1 (stock)
    const msg = await agentB.waitForMsg("chat");
    expect(msg.chat_id).toBe("intent-300");
    expect(msg.from).toBe("carol");

    agentA.close();
    agentB.close();
  });

  // ── No match falls through to broadcast ───────────────────────────────

  it("falls through to broadcast when no agent intents match", async () => {
    const agent = await connectAgentWithIntents(port, "weather", ["forecast", "rain", "temperature"]);
    const ack = await agent.waitForMsg("register_ack");
    expect(ack.status).toBe("ok");

    const messageEvents: any[] = [];
    hub.on("message", (evt: any) => messageEvents.push(evt));

    (hub as any).routeChat({
      chatId: "intent-400",
      content: "What is the meaning of life?",
      from: "dave",
      source: "channel",
    });

    await delay(100);
    // Should fall through to broadcast since no intents match
    expect(messageEvents.length).toBe(1);
    expect(messageEvents[0].content).toBe("What is the meaning of life?");

    agent.close();
  });

  // ── @agent bypass takes priority over intent matching ─────────────────

  it("@agent bypass takes priority over intent matching", async () => {
    const agentA = await connectAgentWithIntents(port, "alpha", ["stock", "earnings"]);
    const ackA = await agentA.waitForMsg("register_ack");
    expect(ackA.status).toBe("ok");

    const agentB = await connectAgentWithIntents(port, "beta", ["price", "market"]);
    const ackB = await agentB.waitForMsg("register_ack");
    expect(ackB.status).toBe("ok");

    // Message mentions @beta but content contains alpha's keyword "stock"
    (hub as any).routeChat({
      chatId: "intent-500",
      content: "@beta check the stock price",
      from: "eve",
      source: "channel",
    });

    // beta should receive it via @mention bypass, not alpha via intent
    const msg = await agentB.waitForMsg("chat");
    expect(msg.chat_id).toBe("intent-500");
    expect(msg.content).toBe("check the stock price");

    agentA.close();
    agentB.close();
  });

  // ── Auto-handover is set up for intent routes ─────────────────────────

  it("sets up auto-handover for intent-routed chats", async () => {
    const agent = await connectAgentWithIntents(port, "polymarket", ["odds", "prediction", "bet"]);
    const ack = await agent.waitForMsg("register_ack");
    expect(ack.status).toBe("ok");
    const agentId = ack.agent_id;

    expect(hub.chatRoutes.has("intent-600")).toBe(false);

    (hub as any).routeChat({
      chatId: "intent-600",
      content: "What are the odds on the election?",
      from: "frank",
      source: "channel",
    });

    await agent.waitForMsg("chat");

    // Chat route should be established
    expect(hub.chatRoutes.has("intent-600")).toBe(true);
    expect(hub.chatRoutes.get("intent-600")).toBe(agentId);

    agent.close();
  });

  // ── intentRoute event is emitted ──────────────────────────────────────

  it("emits intentRoute event with match details", async () => {
    const agent = await connectAgentWithIntents(port, "dexter", ["stock", "analyze", "earnings", "NVDA"]);
    const ack = await agent.waitForMsg("register_ack");
    expect(ack.status).toBe("ok");
    const agentId = ack.agent_id;

    const intentRoutePromise = waitForEvent(hub, "intentRoute");

    (hub as any).routeChat({
      chatId: "intent-700",
      content: "analyze NVDA stock",
      from: "grace",
      source: "channel",
    });

    const event = await intentRoutePromise;
    expect(event.chatId).toBe("intent-700");
    expect(event.agentName).toBe("dexter");
    expect(event.agentId).toBe(agentId);
    expect(event.bestScore).toBe(3); // "analyze", "nvda", "stock"
    expect(event.matches).toBeInstanceOf(Array);
    expect(event.matches.length).toBe(1); // only dexter matched
    expect(event.matches[0].matched).toHaveLength(3);

    agent.close();
  });

  // ── Existing chatRoute prevents intent matching ───────────────────────

  it("skips intent matching when chatRoute already exists", async () => {
    const agentA = await connectAgentWithIntents(port, "assigned", ["stock"]);
    const ackA = await agentA.waitForMsg("register_ack");
    expect(ackA.status).toBe("ok");

    const agentB = await connectAgentWithIntents(port, "stock-bot", ["stock", "price"]);
    const ackB = await agentB.waitForMsg("register_ack");
    expect(ackB.status).toBe("ok");

    // Pre-assign the chat to agentA
    hub.chatRoutes.set("intent-800", ackA.agent_id);

    (hub as any).routeChat({
      chatId: "intent-800",
      content: "stock price of AAPL?",
      from: "henry",
      source: "channel",
    });

    // agentA should receive it via existing chatRoute, not agentB via intent
    const msg = await agentA.waitForMsg("chat");
    expect(msg.chat_id).toBe("intent-800");
    expect(msg.content).toBe("stock price of AAPL?");

    agentA.close();
    agentB.close();
  });

  // ── Intents loaded from metadata on registration ──────────────────────

  it("stores intents from metadata on agent registration", async () => {
    const intents = ["stock", "earnings", "portfolio"];
    const agent = await connectAgentWithIntents(port, "meta-agent", intents);
    const ack = await agent.waitForMsg("register_ack");
    expect(ack.status).toBe("ok");

    const agentState = hub.agents.get(ack.agent_id);
    expect(agentState).toBeDefined();
    expect(agentState!.intents).toEqual(intents);

    agent.close();
  });

  // ── Agent with no intents is skipped ──────────────────────────────────

  it("agents without intents are skipped during intent matching", async () => {
    // Connect an agent without intents
    const agentNoIntents = await connectRawAgent(port, "plain-agent");
    const ackNo = await agentNoIntents.waitForMsg("register_ack");
    expect(ackNo.status).toBe("ok");

    // Connect an agent with intents
    const agentWithIntents = await connectAgentWithIntents(port, "smart-agent", ["hello", "greet"]);
    const ackWith = await agentWithIntents.waitForMsg("register_ack");
    expect(ackWith.status).toBe("ok");

    (hub as any).routeChat({
      chatId: "intent-900",
      content: "hello there!",
      from: "iris",
      source: "channel",
    });

    // smart-agent should handle it, not plain-agent
    const msg = await agentWithIntents.waitForMsg("chat");
    expect(msg.chat_id).toBe("intent-900");

    agentNoIntents.close();
    agentWithIntents.close();
  });

  // ── Works with agent source messages ──────────────────────────────────

  it("intent routing works for agent-sourced messages", async () => {
    const agent = await connectAgentWithIntents(port, "translator", ["translate", "language"]);
    const ack = await agent.waitForMsg("register_ack");
    expect(ack.status).toBe("ok");

    (hub as any).routeChat({
      chatId: "intent-1000",
      content: "translate this to French",
      from: "other-agent",
      source: "agent",
    });

    const msg = await agent.waitForMsg("chat");
    expect(msg.chat_id).toBe("intent-1000");
    expect(msg.content).toBe("translate this to French");

    agent.close();
  });
});
