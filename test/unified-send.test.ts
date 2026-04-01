/**
 * Unified `send` tool test suite.
 *
 * Tests the unified send tool on the edge agent which merges
 * reply + send_message with built-in contact name resolution.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestHub, connectRawAgent, waitForEvent, delay } , startTestServer , startTestServer from "./helpers.js";
import type { ChannelHub } from "../dist/index.js";

// Use a unique port range to avoid collisions with other test files
let sendPortCounter = 19500;
function nextSendPort(): number { return sendPortCounter++; }

let hub: ChannelHub;
let port: number;

describe("Unified send tool (via ChannelHub)", () => {
  beforeEach(async () => {
    port = nextSendPort();
    hub = createTestHub({ name: "send-test-server", port });
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

  // ── Contact resolution ────────────────────────────────────────────────

  it("resolveContact returns undefined for unknown names", () => {
    const result = hub.resolveContact("nobody");
    expect(result).toBeUndefined();
  });

  it("resolveContact returns contact by exact name", () => {
    hub.registerContact("alice", "telegram", "12345");
    const result = hub.resolveContact("alice");
    expect(result).toBeDefined();
    expect(result!.contact.name).toBe("alice");
    expect(result!.channel.type).toBe("telegram");
    expect(result!.channel.id).toBe("12345");
  });

  it("resolveContact finds contact by channel id", () => {
    hub.registerContact("bob", "discord", "99999");
    const result = hub.resolveContact("99999");
    expect(result).toBeDefined();
    expect(result!.contact.name).toBe("bob");
  });

  // ── sendMessage with contact resolution ─────────────────────────────

  it("sendMessage resolves contact name to channel id", async () => {
    const agent = await connectRawAgent(port, "worker-1");
    const ack = await agent.waitForMsg("register_ack");
    expect(ack.status).toBe("ok");
    const agentId = ack.agent_id;

    // Register a contact that maps to the agent's ID
    hub.registerContact("myworker", "agent", agentId);

    // sendMessage with contact name should resolve and deliver
    const result = hub.sendMessage("myworker", "hello via contact");
    expect(result.ok).toBe(true);

    // The agent should receive the message
    const msg = await agent.waitForMsg("chat");
    expect(msg.content).toBe("hello via contact");

    agent.close();
  });

  // ── reply with contact resolution ────────────────────────────────────

  it("reply resolves contact name to channel id", async () => {
    const agent = await connectRawAgent(port, "responder");
    const ack = await agent.waitForMsg("register_ack");
    expect(ack.status).toBe("ok");
    const agentId = ack.agent_id;

    // Register a contact pointing to the agent
    hub.registerContact("resp-contact", "agent", agentId);

    const result = hub.reply("resp-contact", "reply via contact");
    expect(result.ok).toBe(true);

    const msg = await agent.waitForMsg("reply");
    expect(msg.text).toBe("reply via contact");

    agent.close();
  });

  // ── send tool logic (simulated at hub level) ───────────────────────

  /**
   * The unified send tool resolves in this order:
   * 1. Contact registry lookup
   * 2. Chat route check
   * 3. Agent name/ID lookup
   * 4. Fallback to reply()
   *
   * Here we test the resolution logic that the talon-architect tool handler uses.
   */

  it("send resolves contact name and delivers via sendMessage", async () => {
    const agent = await connectRawAgent(port, "target-agent");
    const ack = await agent.waitForMsg("register_ack");
    const agentId = ack.agent_id;

    // Register contact
    hub.registerContact("friend", "agent", agentId);

    // Simulate send tool: resolve contact -> sendMessage
    const contact = hub.resolveContact("friend");
    expect(contact).toBeDefined();
    const channelId = contact!.channel.id;
    const routeOwner = hub.chatRoutes.get(channelId);
    expect(routeOwner).toBeUndefined(); // no route, so sendMessage
    const result = hub.sendMessage(channelId, "hi friend");
    expect(result.ok).toBe(true);

    const msg = await agent.waitForMsg("chat");
    expect(msg.content).toBe("hi friend");

    agent.close();
  });

  it("send uses reply when chat route exists for resolved contact", async () => {
    const agent = await connectRawAgent(port, "routed-agent");
    const ack = await agent.waitForMsg("register_ack");
    const agentId = ack.agent_id;

    // Set up a chat route mapping chatId -> agent
    const chatId = "telegram-chat-42";
    hub.chatRoutes.set(chatId, agentId);

    // Register contact pointing to that chatId
    hub.registerContact("routed-person", "telegram", chatId);

    // Simulate send tool logic: resolve contact -> check route -> reply
    const contact = hub.resolveContact("routed-person");
    expect(contact).toBeDefined();
    const resolvedId = contact!.channel.id;
    expect(resolvedId).toBe(chatId);
    const routeOwner = hub.chatRoutes.get(resolvedId);
    expect(routeOwner).toBe(agentId);

    // Use reply since there's a route
    const result = hub.reply(resolvedId, "hello routed");
    expect(result.ok).toBe(true);

    const msg = await agent.waitForMsg("chat");
    expect(msg.content).toBe("hello routed");

    agent.close();
  });

  it("send falls through to agent name lookup when no contact match", async () => {
    const agent = await connectRawAgent(port, "direct-agent");
    const ack = await agent.waitForMsg("register_ack");

    // No contact registered; use agent name directly
    const contact = hub.resolveContact("direct-agent");
    expect(contact).toBeUndefined();

    const routeOwner = hub.chatRoutes.get("direct-agent");
    expect(routeOwner).toBeUndefined();

    const foundAgent = hub.findAgent("direct-agent");
    expect(foundAgent).toBeDefined();

    const result = hub.sendMessage(foundAgent!.id, "direct message");
    expect(result.ok).toBe(true);

    const msg = await agent.waitForMsg("chat");
    expect(msg.content).toBe("direct message");

    agent.close();
  });

  it("send falls back to reply for unknown targets (channel client routing)", () => {
    // With no agents, contacts, or routes, reply returns an error
    const contact = hub.resolveContact("unknown-target");
    expect(contact).toBeUndefined();
    const routeOwner = hub.chatRoutes.get("unknown-target");
    expect(routeOwner).toBeUndefined();
    const agent = hub.findAgent("unknown-target");
    expect(agent).toBeUndefined();

    const result = hub.reply("unknown-target", "fallback");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("No route");
  });

  // ── Contact registration helpers ──────────────────────────────────────

  it("registerContact and removeContact work correctly", () => {
    hub.registerContact("charlie", "slack", "C123");
    const contacts = hub.listContacts();
    expect(contacts).toHaveLength(1);
    expect(contacts[0].name).toBe("charlie");

    hub.removeContact("charlie");
    expect(hub.listContacts()).toHaveLength(0);
  });

  it("registerContact adds multiple channels for same contact", () => {
    hub.registerContact("dave", "telegram", "111");
    hub.registerContact("dave", "discord", "222");
    const contacts = hub.listContacts();
    expect(contacts).toHaveLength(1);
    expect(contacts[0].channels).toHaveLength(2);

    // Resolve returns first channel
    const resolved = hub.resolveContact("dave");
    expect(resolved).toBeDefined();
    expect(resolved!.channel.type).toBe("telegram");
    expect(resolved!.channel.id).toBe("111");
  });

  // ── Edge cases ──────────────────────────────────────────────────────

  it("send with chat_id that is also an agent ID prefers route over agent", async () => {
    const agent1 = await connectRawAgent(port, "agent-alpha");
    const ack1 = await agent1.waitForMsg("register_ack");
    const agent1Id = ack1.agent_id;

    const agent2 = await connectRawAgent(port, "agent-beta");
    const ack2 = await agent2.waitForMsg("register_ack");
    const agent2Id = ack2.agent_id;

    // Create a route from agent1Id -> agent2
    hub.chatRoutes.set(agent1Id, agent2Id);

    // Simulate send tool: no contact match, but route exists for agent1Id
    const contact = hub.resolveContact(agent1Id);
    // May or may not resolve via contact, but route takes priority in send logic
    const routeOwner = hub.chatRoutes.get(agent1Id);
    expect(routeOwner).toBe(agent2Id);

    // reply should route to agent2 via the chat route
    const result = hub.reply(agent1Id, "routed msg");
    expect(result.ok).toBe(true);

    const msg = await agent2.waitForMsg("chat");
    expect(msg.content).toBe("routed msg");

    agent1.close();
    agent2.close();
  });
});
