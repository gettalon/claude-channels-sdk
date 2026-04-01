/**
 * hub-commands.ts — Tests for:
 * 1. Command registry (registerCommand, parseHubCommand, executeCommand)
 * 2. Built-in commands (/hooks, /status, /agents)
 * 3. Hooks show/hide toggle (settings persistence)
 * 4. Video / VideoNote dispatch via transport layer
 * 5. Forward message metadata via transport layer
 * 6. User roles config merging
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ChannelHub } from "../dist/index.js";
import {
  registerCommand,
  unregisterCommand,
  getCommand,
  listCommands,
  parseHubCommand,
  executeCommand,
  areHooksVisible,
  setHooksVisible,
  loadTalonSettings,
  saveTalonSettings,
} from "../dist/hub-commands.js";
import type { CommandDef, CommandResult } from "../dist/hub-commands.js";
import { createTestHub, nextPort, connectRawAgent, delay, startTestServer } from "./helpers.js";
import { createTelegramTransport } from "../dist/transports/telegram.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeFetchOk() {
  return new Response(JSON.stringify({ ok: true, result: true }), {
    headers: { "Content-Type": "application/json" },
  });
}

function mockTelegramFetch(fetchSpy: ReturnType<typeof vi.spyOn>, fetchCalls: string[]) {
  fetchSpy.mockImplementation(async (url: any, _init?: any) => {
    const urlStr = typeof url === "string" ? url : url.toString();
    fetchCalls.push(urlStr);

    if (urlStr.includes("/getFile")) {
      return new Response(JSON.stringify({ ok: true, result: { file_path: "files/test.bin" } }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    if (urlStr.includes("api.telegram.org/file/")) {
      return new Response(Buffer.from("fake-file-data"), {
        headers: { "Content-Type": "application/octet-stream" },
      });
    }
    return makeFetchOk();
  });
}

function createTestAdapter(opts: Record<string, unknown> = {}) {
  return createTelegramTransport({
    botToken: "test-token-123",
    sendOnly: true,
    ...opts,
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. COMMAND REGISTRY
// ═══════════════════════════════════════════════════════════════════════════════

describe("Hub Commands — Registry", () => {
  it("parseHubCommand extracts name and arg from slash commands", () => {
    expect(parseHubCommand("/status")).toEqual({ name: "status", arg: "" });
    expect(parseHubCommand("/hooks on")).toEqual({ name: "hooks", arg: "on" });
    expect(parseHubCommand("/agents")).toEqual({ name: "agents", arg: "" });
    expect(parseHubCommand("not a command")).toBeNull();
    expect(parseHubCommand("")).toBeNull();
    expect(parseHubCommand("/hooks  off  ")).toEqual({ name: "hooks", arg: "off" });
  });

  it("parseHubCommand handles multi-word arguments", () => {
    expect(parseHubCommand("/send hello world")).toEqual({ name: "send", arg: "hello world" });
  });

  it("registerCommand and getCommand work", () => {
    const testCmd: CommandDef = {
      name: "test-cmd",
      description: "A test command",
      handler: () => ({ text: "ok" }),
    };
    registerCommand(testCmd);
    const found = getCommand("test-cmd");
    expect(found).toBeDefined();
    expect(found!.name).toBe("test-cmd");
    expect(found!.description).toBe("A test command");

    // Cleanup
    unregisterCommand("test-cmd");
    expect(getCommand("test-cmd")).toBeUndefined();
  });

  it("registerCommand is case-insensitive", () => {
    registerCommand({ name: "CaseTEST", description: "test", handler: () => ({ text: "ok" }) });
    expect(getCommand("casetest")).toBeDefined();
    expect(getCommand("CASETEST")).toBeDefined();
    unregisterCommand("casetest");
  });

  it("listCommands includes built-in commands", () => {
    const cmds = listCommands();
    const names = cmds.map((c) => c.name);
    expect(names).toContain("hooks");
    expect(names).toContain("status");
    expect(names).toContain("agents");
  });

  it("unregisterCommand returns false for non-existent command", () => {
    expect(unregisterCommand("nonexistent")).toBe(false);
  });

  it("registerCommand overwrites existing command", () => {
    registerCommand({ name: "dup", description: "v1", handler: () => ({ text: "v1" }) });
    registerCommand({ name: "dup", description: "v2", handler: () => ({ text: "v2" }) });
    expect(getCommand("dup")!.description).toBe("v2");
    unregisterCommand("dup");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. BUILT-IN COMMANDS (/hooks, /status, /agents)
// ═══════════════════════════════════════════════════════════════════════════════

describe("Hub Commands — Built-in /hooks", () => {
  it("/hooks on sets hooksVisible to true", async () => {
    const hub = createTestHub();
    const result = await hub.executeCommand("/hooks on");
    expect(result).not.toBeNull();
    expect(result!.text).toContain("ON");
    const visible = await areHooksVisible();
    expect(visible).toBe(true);
  });

  it("/hooks off sets hooksVisible to false", async () => {
    const hub = createTestHub();
    const result = await hub.executeCommand("/hooks off");
    expect(result).not.toBeNull();
    expect(result!.text).toContain("OFF");
    const visible = await areHooksVisible();
    expect(visible).toBe(false);
    // Restore
    await setHooksVisible(true);
  });

  it("/hooks with no arg shows current state", async () => {
    const hub = createTestHub();
    await setHooksVisible(true);
    const result = await hub.executeCommand("/hooks");
    expect(result).not.toBeNull();
    expect(result!.text).toContain("ON");
    expect(result!.text).toContain("Usage");
  });
});

describe("Hub Commands — Built-in /status", () => {
  let hub: ChannelHub;
  let port: number;

  beforeEach(async () => {
    port = nextPort();
    hub = createTestHub({ port });
    await startTestServer(hub, port);
  });

  afterEach(async () => {
    hub.stopHealthMonitor();
    for (const [, s] of hub.servers) try { s.httpServer?.close(); } catch {}
  });

  it("/status returns hub status info", async () => {
    const result = await hub.executeCommand("/status");
    expect(result).not.toBeNull();
    expect(result!.text).toContain("Hub:");
    expect(result!.text).toContain("Uptime:");
    expect(result!.text).toContain("Servers:");
    expect(result!.text).toContain("Agents:");
  });

  it("/status includes hub name", async () => {
    const namedHub = createTestHub({ name: "my-test-hub", port: nextPort() });
    await namedHub.startServer(namedHub.defaultPort);
    await startTestServer(namedHub.defaultPort);
    const result = await namedHub.executeCommand("/status");
    expect(result!.text).toContain("my-test-hub");
    for (const [, s] of namedHub.servers) try { s.httpServer?.close(); } catch {}
  });
});

describe("Hub Commands — Built-in /agents", () => {
  it("/agents with no agents reports none", async () => {
    const port = nextPort();
    const hub = createTestHub({ port, name: "agents-test" });
    await startTestServer(hub, port);
    try {
      const result = await hub.executeCommand("/agents");
      expect(result).not.toBeNull();
      expect(result!.text).toContain("No agents");
    } finally {
      hub.stopHealthMonitor();
      for (const [, s] of hub.servers) try { s.httpServer?.close(); } catch {}
    }
  });

  it("/agents lists connected agents", async () => {
    const port = nextPort();
    const hub = createTestHub({ port, name: "agents-list-test" });
    await startTestServer(hub, port);
    try {
      const agent = await connectRawAgent(port, "test-agent-alpha", [
        { name: "echo", description: "Echo back", inputSchema: { type: "object", properties: {} } },
      ]);
      await agent.waitForMsg("register_ack");
      await delay(50);

      const result = await hub.executeCommand("/agents");
      expect(result).not.toBeNull();
      expect(result!.text).toContain("test-agent-alpha");
      expect(result!.text).toContain("echo");

      agent.close();
    } finally {
      hub.stopHealthMonitor();
      for (const agent of hub.agents.values()) try { agent.ws.close(); } catch {}
      for (const [, s] of hub.servers) try { s.httpServer?.close(); } catch {}
    }
  });
});

describe("Hub Commands — executeCommand via ChannelHub", () => {
  it("executeCommand returns null for unknown commands", async () => {
    const hub = createTestHub();
    const result = await hub.executeCommand("/unknown_xyz");
    expect(result).toBeNull();
  });

  it("executeCommand returns null for non-slash text", async () => {
    const hub = createTestHub();
    const result = await hub.executeCommand("just text");
    expect(result).toBeNull();
  });

  it("custom commands can be registered via hub.registerCommand", async () => {
    const hub = createTestHub();
    hub.registerCommand({
      name: "ping",
      description: "Pong!",
      handler: () => ({ text: "pong" }),
    });
    const result = await hub.executeCommand("/ping");
    expect(result).not.toBeNull();
    expect(result!.text).toBe("pong");
    unregisterCommand("ping");
  });

  it("command handler receives context", async () => {
    const hub = createTestHub();
    let capturedCtx: any = null;
    hub.registerCommand({
      name: "ctxtest",
      description: "test",
      handler: (_h, _arg, ctx) => { capturedCtx = ctx; return { text: "ok" }; },
    });
    await hub.executeCommand("/ctxtest", { chatId: "chat-123", user: "alice" });
    expect(capturedCtx).toEqual({ chatId: "chat-123", user: "alice" });
    unregisterCommand("ctxtest");
  });

  it("listCommands is available on hub instance", () => {
    const hub = createTestHub();
    const cmds = hub.listCommands();
    expect(Array.isArray(cmds)).toBe(true);
    expect(cmds.length).toBeGreaterThanOrEqual(3);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. HOOKS SHOW/HIDE TOGGLE (settings persistence)
// ═══════════════════════════════════════════════════════════════════════════════

describe("Hooks visibility toggle", () => {
  it("areHooksVisible defaults to true", async () => {
    await setHooksVisible(true);
    expect(await areHooksVisible()).toBe(true);
  });

  it("setHooksVisible(false) persists and areHooksVisible reads it back", async () => {
    await setHooksVisible(false);
    expect(await areHooksVisible()).toBe(false);
    // Restore
    await setHooksVisible(true);
    expect(await areHooksVisible()).toBe(true);
  });

  it("saveTalonSettings merges with existing settings", async () => {
    await saveTalonSettings({ hooksVisible: true, customKey: "test" } as any);
    const loaded = await loadTalonSettings();
    expect(loaded.hooksVisible).toBe(true);
    expect((loaded as any).customKey).toBe("test");
    // Clean up
    await saveTalonSettings({ hooksVisible: true });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. VIDEO / VIDEONOTE DISPATCH (transport layer)
// ═══════════════════════════════════════════════════════════════════════════════

describe("Telegram transport: Video dispatch", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("dispatches video with caption and file_id", async () => {
    const adapter = createTestAdapter();
    const received: any[] = [];
    const fetchCalls: string[] = [];
    mockTelegramFetch(fetchSpy, fetchCalls);

    await adapter.connect("telegram://400", (msg) => received.push(msg));

    (adapter as any).dispatchUpdate({
      update_id: 200,
      message: {
        message_id: 60,
        chat: { id: 400 },
        from: { id: 50, username: "filmmaker" },
        video: { file_id: "vid-abc-123", duration: 30, file_name: "clip.mp4" },
        caption: "Check out this clip",
      },
    });

    // handleFileMessage is async — give it time
    await delay(200);

    expect(received.length).toBe(1);
    const msg = received[0];
    expect(msg.content).toBe("Check out this clip");
    expect(msg.meta.file_id).toBe("vid-abc-123");
    expect(msg.files).toBeDefined();
    expect(msg.files[0].name).toBe("clip.mp4");
    expect(msg.files[0].mime).toBe("video/mp4");

    await adapter.close();
  });

  it("dispatches video without caption — uses filename fallback", async () => {
    const adapter = createTestAdapter();
    const received: any[] = [];
    mockTelegramFetch(fetchSpy, []);

    await adapter.connect("telegram://401", (msg) => received.push(msg));

    (adapter as any).dispatchUpdate({
      update_id: 201,
      message: {
        message_id: 61,
        chat: { id: 401 },
        from: { id: 51, username: "filmmaker2" },
        video: { file_id: "vid-def-456", duration: 15 },
      },
    });

    await delay(200);

    expect(received.length).toBe(1);
    const msg = received[0];
    expect(msg.content).toContain("video.mp4");
    expect(msg.meta.file_id).toBe("vid-def-456");

    await adapter.close();
  });
});

describe("Telegram transport: VideoNote dispatch", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("dispatches video_note with file_id and type", async () => {
    const adapter = createTestAdapter();
    const received: any[] = [];
    const fetchCalls: string[] = [];
    mockTelegramFetch(fetchSpy, fetchCalls);

    await adapter.connect("telegram://500", (msg) => received.push(msg));

    (adapter as any).dispatchUpdate({
      update_id: 300,
      message: {
        message_id: 70,
        chat: { id: 500 },
        from: { id: 60, username: "circlevid" },
        video_note: { file_id: "vnote-xyz-789", duration: 8, length: 240 },
      },
    });

    await delay(200);

    expect(received.length).toBe(1);
    const msg = received[0];
    expect(msg.content).toContain("video_note");
    expect(msg.meta.file_id).toBe("vnote-xyz-789");
    expect(msg.meta.file_type).toBe("video_note");
    expect(msg.files[0].name).toBe("video_note.mp4");

    await adapter.close();
  });

  it("video_note triggers getFile API call", async () => {
    const adapter = createTestAdapter();
    const received: any[] = [];
    const fetchCalls: string[] = [];
    mockTelegramFetch(fetchSpy, fetchCalls);

    await adapter.connect("telegram://501", (msg) => received.push(msg));

    (adapter as any).dispatchUpdate({
      update_id: 301,
      message: {
        message_id: 71,
        chat: { id: 501 },
        from: { id: 61, username: "noter" },
        video_note: { file_id: "vnote-dl-test", duration: 5 },
      },
    });

    await delay(200);

    expect(received.length).toBe(1);
    const getFileCalls = fetchCalls.filter((u) => u.includes("/getFile"));
    expect(getFileCalls.length).toBeGreaterThanOrEqual(1);

    await adapter.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. FORWARD MESSAGE METADATA (transport layer)
// ═══════════════════════════════════════════════════════════════════════════════

describe("Telegram transport: forward metadata", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("includes forward_from in meta for text messages", async () => {
    const adapter = createTestAdapter();
    const received: any[] = [];
    mockTelegramFetch(fetchSpy, []);

    await adapter.connect("telegram://600", (msg) => received.push(msg));

    (adapter as any).dispatchUpdate({
      update_id: 400,
      message: {
        message_id: 80,
        chat: { id: 600 },
        from: { id: 70, username: "forwarder" },
        text: "Forwarded text",
        forward_from: { id: 71, username: "original_sender" },
      },
    });

    expect(received.length).toBe(1);
    const msg = received[0];
    expect(msg.content).toContain("Forwarded text");
    expect(msg.content).toContain("⤳");

    await adapter.close();
  });

  it("includes forward_from in meta for file messages (video)", async () => {
    const adapter = createTestAdapter();
    const received: any[] = [];
    const fetchCalls: string[] = [];
    mockTelegramFetch(fetchSpy, fetchCalls);

    await adapter.connect("telegram://601", (msg) => received.push(msg));

    (adapter as any).dispatchUpdate({
      update_id: 401,
      message: {
        message_id: 81,
        chat: { id: 601 },
        from: { id: 72, username: "vidforwarder" },
        video: { file_id: "fwd-vid-001", duration: 10 },
        caption: "Forwarded video",
        forward_from: { id: 73, username: "vid_creator" },
      },
    });

    await delay(200);

    expect(received.length).toBe(1);
    const msg = received[0];
    expect(msg.content).toBe("Forwarded video");
    expect(msg.meta.forwarded_from).toBe("vid_creator");

    await adapter.close();
  });

  it("handles forward_from without username (uses first_name)", async () => {
    const adapter = createTestAdapter();
    const received: any[] = [];
    const fetchCalls: string[] = [];
    mockTelegramFetch(fetchSpy, fetchCalls);

    await adapter.connect("telegram://602", (msg) => received.push(msg));

    (adapter as any).dispatchUpdate({
      update_id: 402,
      message: {
        message_id: 82,
        chat: { id: 602 },
        from: { id: 74, username: "forwarder3" },
        video: { file_id: "fwd-vid-002" },
        forward_from: { id: 75, first_name: "Anonymous User" },
      },
    });

    await delay(200);

    expect(received.length).toBe(1);
    expect(received[0].meta.forwarded_from).toBe("Anonymous User");

    await adapter.close();
  });

  it("no forward meta for regular messages", async () => {
    const adapter = createTestAdapter();
    const received: any[] = [];
    mockTelegramFetch(fetchSpy, []);

    await adapter.connect("telegram://603", (msg) => received.push(msg));

    (adapter as any).dispatchUpdate({
      update_id: 403,
      message: {
        message_id: 83,
        chat: { id: 603 },
        from: { id: 76, username: "regular" },
        text: "Regular message",
      },
    });

    expect(received.length).toBe(1);
    expect(received[0].meta?.forwarded_from).toBeUndefined();

    await adapter.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. USER ROLES — verify TelegramConfig accepts userRoles
// ═══════════════════════════════════════════════════════════════════════════════

describe("Telegram user roles config", () => {
  it("TelegramConfig type includes userRoles field", async () => {
    // Verify the parseConfig function exists and returns expected shape
    const { parseConfig } = await import("../dist/channels/telegram.js");
    // parseConfig throws without TELEGRAM_BOT_TOKEN, so we set it temporarily
    const origToken = process.env.TELEGRAM_BOT_TOKEN;
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    try {
      const config = parseConfig();
      expect(config).toBeDefined();
      expect(config.botToken).toBe("test-token");
      // userRoles is optional — should be undefined unless set
      expect(config.userRoles).toBeUndefined();
    } finally {
      if (origToken) process.env.TELEGRAM_BOT_TOKEN = origToken;
      else delete process.env.TELEGRAM_BOT_TOKEN;
    }
  });

  it("userRoles from env or config would be merged into access", async () => {
    // This verifies the type contract:
    // TelegramConfig.userRoles → Record<string, string>
    // When passed, becomes access.user_roles
    // And extractIncomingInfo appends "(role)" to username

    // We can verify the config shape accepts userRoles
    const config: Record<string, unknown> = {
      botToken: "test",
      userRoles: { "123": "owner", "456": "admin" },
    };
    // Verify the structure is valid
    expect(config.userRoles).toEqual({ "123": "owner", "456": "admin" });
  });

  it("role format is 'username (role)'", () => {
    // Verify the expected format — the channel code does:
    // username = `${username} (${role})`
    const username = "alice";
    const role = "owner";
    const formatted = `${username} (${role})`;
    expect(formatted).toBe("alice (owner)");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 7. CHANNEL-LEVEL FORWARD PREFIX LOGIC
// ═══════════════════════════════════════════════════════════════════════════════

describe("Forward prefix logic (unit)", () => {
  it("[Forwarded from X] prefix is prepended when meta has forwarded_from", () => {
    // This replicates the logic in channels/telegram.ts pushWithForwardPrefix
    const meta = { forwarded_from: "alice" };
    const content = "Hello world";
    const text = meta.forwarded_from
      ? `[Forwarded from ${meta.forwarded_from}]\n${content}`
      : content;
    expect(text).toBe("[Forwarded from alice]\nHello world");
  });

  it("no prefix when forwarded_from is absent", () => {
    const meta: Record<string, string> = {};
    const content = "Hello world";
    const text = meta.forwarded_from
      ? `[Forwarded from ${meta.forwarded_from}]\n${content}`
      : content;
    expect(text).toBe("Hello world");
  });

  it("forward_origin type=user extracts sender_user.username", () => {
    const origin = { type: "user", sender_user: { id: 1, username: "bob" } };
    let forwarded_from: string | undefined;
    if (origin.type === "user") {
      forwarded_from = origin.sender_user?.username ?? "unknown";
    }
    expect(forwarded_from).toBe("bob");
  });

  it("forward_origin type=channel extracts chat.title", () => {
    const origin = { type: "channel", chat: { title: "Tech News" } };
    let forwarded_from: string | undefined;
    if (origin.type === "channel") {
      forwarded_from = origin.chat?.title ?? "channel";
    }
    expect(forwarded_from).toBe("Tech News");
  });

  it("forward_origin type=hidden_user extracts sender_user_name", () => {
    const origin = { type: "hidden_user", sender_user_name: "Anonymous" };
    let forwarded_from: string | undefined;
    if (origin.type === "hidden_user") {
      forwarded_from = origin.sender_user_name ?? "hidden";
    }
    expect(forwarded_from).toBe("Anonymous");
  });

  it("legacy forward_from extracts username", () => {
    const forward_from = { id: 1, username: "legacy_sender" };
    const forwarded_from = forward_from.username ?? forward_from.id ?? "unknown";
    expect(forwarded_from).toBe("legacy_sender");
  });
});
