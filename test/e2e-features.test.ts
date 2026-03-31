/**
 * E2E tests for core hub features:
 *   1. @mention routing
 *   2. ~blocked-by routing
 *   3. Message buffering for offline agents
 *   4. Agent name from cwd
 *   5. Alias resolution (displayName in settings)
 *   6. Init batching (serverStarted + connected → single notification)
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ChannelHub } from "../dist/index.js";
import { createTestHub, nextPort, delay, waitForEvent, connectRawAgent } from "./helpers.js";
import { basename } from "node:path";

// ── Cleanup helper ──────────────────────────────────────────────────────────

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

// ── 1. @mention routing ─────────────────────────────────────────────────────

describe("@mention routing", () => {
  let hub: ChannelHub;
  let port: number;

  beforeEach(async () => {
    port = nextPort();
    hub = createTestHub({ name: "hub", port });

    // Register the same onMessage hook that architect.ts uses (lines 153-172)
    hub.hook("onMessage", async ({ content, user }) => {
      if (!content) return;
      const atMentions = content.match(/@([\w-]+)/g);
      if (atMentions?.length) {
        const cleanContent = content.replace(/[@~][\w-]+/g, "").trim();
        for (const m of atMentions) {
          const target = m.slice(1);
          if (target !== user) hub.sendMessage(target, `[from ${user}] ${cleanContent}`);
        }
      }
    });

    await hub.startServer(port);
  });

  afterEach(() => cleanupHub(hub));

  it("routes @mention message to the target agent", async () => {
    // Connect sender and target agents
    const sender = await connectRawAgent(port, "alice");
    await sender.waitForMsg("register_ack");

    const target = await connectRawAgent(port, "bob");
    await target.waitForMsg("register_ack");

    // Alice sends a message mentioning @bob — simulate via emitMessage
    (hub as any).emitMessage("Hey @bob check this out", "chat-1", "alice");

    // Bob should receive the routed message
    const msg = await target.waitForMsg("chat", 3000);
    expect(msg.content).toContain("[from alice]");
    expect(msg.content).toContain("check this out");

    sender.close();
    target.close();
  });

  it("does not route @mention back to sender", async () => {
    const agent = await connectRawAgent(port, "alice");
    await agent.waitForMsg("register_ack");

    // Alice mentions herself — should NOT receive a routed message
    (hub as any).emitMessage("note to @alice self", "chat-2", "alice");

    // Wait briefly — no message should arrive
    await delay(300);
    const selfMsg = agent.messages.find(
      (m) => m.type === "chat" && m.content?.includes("[from alice]")
    );
    expect(selfMsg).toBeUndefined();

    agent.close();
  });
});

// ── 2. ~blocked-by routing ──────────────────────────────────────────────────

describe("~blocked-by routing", () => {
  let hub: ChannelHub;
  let port: number;

  beforeEach(async () => {
    port = nextPort();
    hub = createTestHub({ name: "hub", port });

    // Register the ~blocked-by hook from architect.ts (lines 164-170)
    hub.hook("onMessage", async ({ content, user }) => {
      if (!content) return;
      const cleanContent = content.replace(/[@~][\w-]+/g, "").trim();
      const tildeRefs = content.match(/~([\w-]+)/g);
      if (tildeRefs?.length) {
        for (const m of tildeRefs) {
          const blocker = m.slice(1);
          if (blocker !== user) hub.sendMessage(blocker, `[waiting] ${user} is blocked by you: ${cleanContent}`);
        }
      }
    });

    await hub.startServer(port);
  });

  afterEach(() => cleanupHub(hub));

  it("notifies the blocker when ~agent is used", async () => {
    const waiter = await connectRawAgent(port, "frontend");
    await waiter.waitForMsg("register_ack");

    const blocker = await connectRawAgent(port, "backend");
    await blocker.waitForMsg("register_ack");

    // frontend says it's blocked by ~backend
    (hub as any).emitMessage("I need the API ~backend to continue", "chat-3", "frontend");

    // backend should get a waiting notification
    const msg = await blocker.waitForMsg("chat", 3000);
    expect(msg.content).toContain("[waiting]");
    expect(msg.content).toContain("frontend is blocked by you");

    waiter.close();
    blocker.close();
  });
});

// ── 3. Message buffering for offline agents ─────────────────────────────────

describe("message buffering", () => {
  let hub: ChannelHub;
  let port: number;

  beforeEach(async () => {
    port = nextPort();
    hub = createTestHub({ name: "hub", port });
    await hub.startServer(port);
  });

  afterEach(() => cleanupHub(hub));

  it("buffers messages for offline agents and delivers on reconnect", async () => {
    // Send messages to an agent that doesn't exist yet
    hub.sendMessage("lazarus", "msg-1");
    hub.sendMessage("lazarus", "msg-2");
    hub.sendMessage("lazarus", "msg-3");

    // Verify messages were buffered
    const buffer = (hub as any).messageBuffer as Map<string, any[]>;
    expect(buffer.get("lazarus")?.length).toBe(3);

    // Now the agent connects
    const agent = await connectRawAgent(port, "lazarus");
    await agent.waitForMsg("register_ack");

    // Agent should receive the "You have 3 buffered messages" notification, then the messages
    // Collect all chat messages within a short window
    await delay(500);
    const chatMsgs = agent.messages.filter((m) => m.type === "chat");

    // Should have the buffered notification + 3 actual messages = 4
    expect(chatMsgs.length).toBeGreaterThanOrEqual(4);

    const notification = chatMsgs.find((m) => m.content?.includes("buffered message"));
    expect(notification).toBeDefined();
    expect(notification.content).toContain("3 buffered messages");

    const contents = chatMsgs.map((m) => m.content);
    expect(contents).toContain("msg-1");
    expect(contents).toContain("msg-2");
    expect(contents).toContain("msg-3");

    // Buffer should be cleared
    expect(buffer.get("lazarus")).toBeUndefined();

    agent.close();
  });

  it("caps buffer at 100 messages per agent", async () => {
    for (let i = 0; i < 120; i++) {
      hub.sendMessage("overloaded", `msg-${i}`);
    }
    const buffer = (hub as any).messageBuffer as Map<string, any[]>;
    expect(buffer.get("overloaded")?.length).toBe(100);

    // Oldest messages should have been dropped — first should be msg-20
    const first = buffer.get("overloaded")![0];
    expect(first.content).toBe("msg-20");
  });
});

// ── 4. Agent name from cwd ──────────────────────────────────────────────────

describe("agent name from cwd", () => {
  it("uses basename of cwd when no name is provided", () => {
    // Clear env vars that would override
    const saved = process.env.TALON_AGENT_NAME;
    delete process.env.TALON_AGENT_NAME;

    const hub = new ChannelHub({
      autoStart: false,
      autoConnect: false,
      autoUpdate: false,
    });

    // Should be the basename of the current working directory
    const expected = basename(process.cwd());
    expect(hub.name).toBe(expected);

    // Restore
    if (saved !== undefined) process.env.TALON_AGENT_NAME = saved;
  });

  it("prefers explicit name over cwd", () => {
    const hub = new ChannelHub({
      name: "explicit-name",
      autoStart: false,
      autoConnect: false,
      autoUpdate: false,
    });
    expect(hub.name).toBe("explicit-name");
  });
});

// ── 5. Alias resolution ────────────────────────────────────────────────────

describe("alias resolution", () => {
  let hub: ChannelHub;
  let port: number;

  beforeEach(async () => {
    port = nextPort();
    hub = createTestHub({ name: "hub", port });
    await hub.startServer(port);
  });

  afterEach(() => cleanupHub(hub));

  it("resolvedName returns agentName when connected as client", () => {
    // When the hub is connected as a client with an agentName, resolvedName should return it
    const clientHub = createTestHub({ name: "raw-name", agentName: "display-alias" });

    // Simulate client connection state by adding a fake server-role client entry
    clientHub.clients.set("fake-server", {
      id: "fake",
      url: "ws://fake",
      channelId: "fake",
      transport: "ws",
      role: "server",
      ws: { close: () => {} },
      name: "fake",
    } as any);

    // resolvedName should return the agentName (display alias)
    const resolved = (clientHub as any).resolvedName();
    expect(resolved).toBe("display-alias");

    cleanupHub(clientHub);
  });

  it("resolvedName returns hub name when running as server", () => {
    // When running as server (no client connections), resolvedName returns hub.name
    const resolved = (hub as any).resolvedName();
    expect(resolved).toBe("hub");
  });
});

// ── 6. Init batching ────────────────────────────────────────────────────────

describe("init batching", () => {
  it("batches serverStarted + connected into a single Ready notification", async () => {
    const port = nextPort();
    const hub = createTestHub({ name: "batch-hub", port });

    // Replicate the init-batching pattern from architect.ts (lines 207-230)
    const initParts: string[] = [];
    let initDone = false;
    const notifications: string[] = [];

    hub.on("serverStarted", ({ port: p }) => {
      if (initDone) {
        notifications.push(`server-started-${p}`);
      } else {
        initParts.push(`Server :${p}`);
      }
    });

    hub.on("connected", ({ url, transport, name }) => {
      if (initDone) {
        notifications.push(`connected-${name}`);
      } else {
        initParts.push(`${name} via ${transport}`);
      }
    });

    // Start the server — this emits "serverStarted"
    await hub.startServer(port);

    // Simulate a "connected" event before init is done
    hub.emit("connected", { url: `ws://localhost:${port}`, transport: "ws", name: "test-conn" });

    // Both events should have been batched, not emitted as separate notifications
    expect(notifications).toHaveLength(0);
    expect(initParts).toHaveLength(2);
    expect(initParts[0]).toContain(`Server :${port}`);
    expect(initParts[1]).toContain("test-conn via ws");

    // Now mark init done and emit another event
    initDone = true;
    hub.emit("serverStarted", { port: port + 1 });
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toBe(`server-started-${port + 1}`);

    // Verify the combined "Ready" message
    const combined = initParts.join(" · ");
    expect(combined).toContain(`Server :${port}`);
    expect(combined).toContain("test-conn via ws");

    cleanupHub(hub);
  });
});
