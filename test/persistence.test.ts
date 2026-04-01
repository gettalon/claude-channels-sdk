/**
 * Persistence test suite.
 *
 * Tests: handover state persistence/restore, contact name resolution,
 * health monitor snapshots, and settings read-merge-write.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestHub, nextPort, makeTempDir, cleanTempDir, delay, connectRawAgent } , startTestServer , startTestServer from "./helpers.js";
import { ChannelHub } from "../dist/index.js";
import { setSettingsPath, loadSettings, saveSettings } from "../dist/hub-settings.js";
import { writeFile, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";

// ── 1. Handover Persistence ──────────────────────────────────────────────────

describe("Handover persistence (persistState / restoreState)", () => {
  let hub: ChannelHub;
  let port: number;
  let tmpDir: string;
  let settingsFile: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir();
    settingsFile = join(tmpDir, "settings.json");
    setSettingsPath(settingsFile);
    port = nextPort();
    hub = createTestHub({ name: "persist-hub", port });
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
    await cleanTempDir(tmpDir);
  });

  it("should persist and restore chat routes across hub instances", async () => {
    // Connect two agents
    const a1 = await connectRawAgent(port, "agent-alpha");
    const a2 = await connectRawAgent(port, "agent-beta");
    await delay(200);

    // Find the registered agent ids
    const alpha = hub.findAgent("agent-alpha");
    const beta = hub.findAgent("agent-beta");
    expect(alpha).toBeDefined();
    expect(beta).toBeDefined();

    // Set up a chat route (handover)
    hub.chatRoutes.set("chat-001", alpha!.id);
    hub.chatRoutes.set("chat-002", beta!.id);

    // Persist state
    await hub.persistState();

    // Verify settings file was written with state
    const raw = JSON.parse(await readFile(settingsFile, "utf-8"));
    expect(raw.state).toBeDefined();
    expect(raw.state.chatRoutes).toBeDefined();
    expect(raw.state.chatRoutes["chat-001"].agentName).toBe("agent-alpha");
    expect(raw.state.chatRoutes["chat-002"].agentName).toBe("agent-beta");

    // Snapshot the persisted state before disconnecting agents (disconnect
    // handlers would overwrite the file with empty routes).
    const snapshot = await readFile(settingsFile, "utf-8");

    // Tear down hub1 completely
    a1.close();
    a2.close();
    for (const [, s] of hub.servers) {
      try { s.wss?.close(); s.httpServer?.close(); } catch {}
    }
    await delay(200);

    // Restore the snapshot so hub2 reads the state that existed before disconnect
    await writeFile(settingsFile, snapshot);

    // Create a new hub, connect new agents with the same names, then restore
    const port2 = nextPort();
    const hub2 = createTestHub({ name: "persist-hub-2", port: port2 });
    await hub2.startServer(port2);

    const a1b = await connectRawAgent(port2, "agent-alpha");
    const a2b = await connectRawAgent(port2, "agent-beta");
    await delay(300);

    // Restore state into the new hub
    await hub2.restoreState();

    // Verify routes were restored using the new agent ids
    const alphaNew = hub2.findAgent("agent-alpha");
    const betaNew = hub2.findAgent("agent-beta");
    expect(alphaNew).toBeDefined();
    expect(betaNew).toBeDefined();
    expect(hub2.chatRoutes.get("chat-001")).toBe(alphaNew!.id);
    expect(hub2.chatRoutes.get("chat-002")).toBe(betaNew!.id);

    // Cleanup second hub
    a1b.close();
    a2b.close();
    for (const [, s] of hub2.servers) {
      try { s.httpServer?.close(); s.wss?.close(); } catch {}
    }
    hub2.stopHealthMonitor();
    await delay(100);
  });

  it("should persist and restore groups across hub instances", async () => {
    // Connect agents
    const a1 = await connectRawAgent(port, "worker-1");
    const a2 = await connectRawAgent(port, "worker-2");
    await delay(200);

    // Create groups and add agents by name
    hub.createGroup("team-a");
    hub.addToGroup("team-a", "worker-1");
    hub.addToGroup("team-a", "worker-2");

    // Persist
    await hub.persistState();

    // Verify file contents — members stored as "ws:name" when auto-resolved
    const raw = JSON.parse(await readFile(settingsFile, "utf-8"));
    expect(raw.state.groups).toBeDefined();
    expect(raw.state.groups["team-a"].some((m: string) => m.includes("worker-1"))).toBe(true);
    expect(raw.state.groups["team-a"].some((m: string) => m.includes("worker-2"))).toBe(true);

    // Snapshot before disconnect handlers can overwrite the file
    const snapshot = await readFile(settingsFile, "utf-8");

    // Tear down hub1
    a1.close();
    a2.close();
    for (const [, s] of hub.servers) {
      try { s.wss?.close(); s.httpServer?.close(); } catch {}
    }
    await delay(200);

    // Restore file to the snapshot with populated groups
    await writeFile(settingsFile, snapshot);

    // New hub with the same agent names
    const port2 = nextPort();
    const hub2 = createTestHub({ name: "persist-hub-grp", port: port2 });
    await hub2.startServer(port2);

    const b1 = await connectRawAgent(port2, "worker-1");
    const b2 = await connectRawAgent(port2, "worker-2");
    await delay(300);

    await hub2.restoreState();

    const group = hub2.groups.get("team-a");
    expect(group).toBeDefined();
    expect(group!.size).toBe(2);
    // Groups store qualified member names as Map keys (e.g. "ws:worker-1")
    const memberKeys = [...group!.keys()];
    expect(memberKeys.some(m => m.includes("worker-1"))).toBe(true);
    expect(memberKeys.some(m => m.includes("worker-2"))).toBe(true);

    // Cleanup
    b1.close();
    b2.close();
    for (const [, s] of hub2.servers) {
      try { s.httpServer?.close(); s.wss?.close(); } catch {}
    }
    hub2.stopHealthMonitor();
    await delay(100);
  });
});

// ── 2. Contact Name Resolution ───────────────────────────────────────────────

describe("Contact name resolution", () => {
  let hub: ChannelHub;
  let tmpDir: string;
  let settingsFile: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir();
    settingsFile = join(tmpDir, "settings.json");
    setSettingsPath(settingsFile);
    // Write an empty settings file to isolate from previous test background writes
    await writeFile(settingsFile, "{}");
    hub = createTestHub({ name: "contacts-hub" });
  });

  afterEach(async () => {
    hub.stopHealthMonitor();
    // Wait for any background persistContacts calls to settle
    await delay(150);
    await cleanTempDir(tmpDir);
  });

  it("should register and resolve a contact by name", () => {
    hub.registerContact("Alice", "telegram", "12345");
    const result = hub.resolveContact("Alice");
    expect(result).toBeDefined();
    expect(result!.contact.name).toBe("Alice");
    expect(result!.channel.type).toBe("telegram");
    expect(result!.channel.id).toBe("12345");
    expect(result!.channel.url).toBe("telegram://12345");
  });

  it("should resolve a contact by channel id", () => {
    hub.registerContact("Bob", "discord", "99999", "https://discord.com/99999");
    const result = hub.resolveContact("99999");
    expect(result).toBeDefined();
    expect(result!.contact.name).toBe("Bob");
    expect(result!.channel.type).toBe("discord");
    expect(result!.channel.url).toBe("https://discord.com/99999");
  });

  it("should return undefined for unknown contacts", () => {
    const result = hub.resolveContact("unknown-person");
    expect(result).toBeUndefined();
  });

  it("should add multiple channels to the same contact", () => {
    hub.registerContact("Charlie", "telegram", "111");
    hub.registerContact("Charlie", "discord", "222");
    const contacts = hub.listContacts();
    expect(contacts).toHaveLength(1);
    expect(contacts[0].channels).toHaveLength(2);
    expect(contacts[0].channels[0].type).toBe("telegram");
    expect(contacts[0].channels[1].type).toBe("discord");
  });

  it("should update url if same type+id is registered again", () => {
    hub.registerContact("Dave", "telegram", "555", "old://url");
    hub.registerContact("Dave", "telegram", "555", "new://url");
    const result = hub.resolveContact("Dave");
    expect(result!.channel.url).toBe("new://url");
    // Should still have only one channel entry
    expect(hub.listContacts()[0].channels).toHaveLength(1);
  });

  it("should auto-register contacts from incoming messages", () => {
    (hub as any).autoRegisterContact("Eve", "chat-42", "telegram");
    const result = hub.resolveContact("Eve");
    expect(result).toBeDefined();
    expect(result!.channel.type).toBe("telegram");
    expect(result!.channel.id).toBe("chat-42");
  });

  it("should skip auto-register for system/unknown usernames", () => {
    (hub as any).autoRegisterContact("unknown", "chat-1", "telegram");
    (hub as any).autoRegisterContact("system", "chat-2", "telegram");
    (hub as any).autoRegisterContact("host", "chat-3", "telegram");
    (hub as any).autoRegisterContact("", "chat-4", "telegram");
    expect(hub.listContacts()).toHaveLength(0);
  });

  it("should remove a contact", () => {
    hub.registerContact("Frank", "telegram", "777");
    expect(hub.listContacts()).toHaveLength(1);
    const result = hub.removeContact("Frank");
    expect(result.ok).toBe(true);
    expect(hub.listContacts()).toHaveLength(0);
    expect(hub.resolveContact("Frank")).toBeUndefined();
  });

  it("should return error when removing a nonexistent contact", () => {
    const result = hub.removeContact("Nobody");
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("should persist and restore contacts round-trip", async () => {
    hub.registerContact("Grace", "telegram", "100");
    hub.registerContact("Grace", "discord", "200");
    hub.registerContact("Heidi", "slack", "300");

    // Allow the background persist to complete
    await delay(200);

    // Verify settings file has contacts
    const raw = JSON.parse(await readFile(settingsFile, "utf-8"));
    expect(raw.contacts).toBeDefined();
    expect(raw.contacts["Grace"]).toBeDefined();
    expect(raw.contacts["Heidi"]).toBeDefined();

    // Create a new hub and restore
    const hub2 = createTestHub({ name: "contacts-restore" });
    await (hub2 as any).restoreContacts();

    const contacts2 = hub2.listContacts();
    expect(contacts2).toHaveLength(2);
    const grace = hub2.resolveContact("Grace");
    expect(grace).toBeDefined();
    expect(grace!.contact.channels).toHaveLength(2);
    const heidi = hub2.resolveContact("Heidi");
    expect(heidi).toBeDefined();
    expect(heidi!.channel.type).toBe("slack");

    hub2.stopHealthMonitor();
  });
});

// ── 3. Health Monitor ────────────────────────────────────────────────────────

describe("Health monitor", () => {
  let hub: ChannelHub;
  let port: number;
  let tmpDir: string;
  let settingsFile: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir();
    settingsFile = join(tmpDir, "settings.json");
    setSettingsPath(settingsFile);
    port = nextPort();
    hub = createTestHub({ name: "health-hub", port });
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
    await cleanTempDir(tmpDir);
  });

  it("should return a health snapshot with correct shape", async () => {
    const health = await hub.getHealth();
    expect(health).toBeDefined();
    expect(health).toHaveProperty("servers");
    expect(health).toHaveProperty("clients");
    expect(health).toHaveProperty("agents");
    expect(health).toHaveProperty("uptime");
    expect(Array.isArray(health.servers)).toBe(true);
    expect(Array.isArray(health.clients)).toBe(true);
    expect(typeof health.agents.total).toBe("number");
    expect(typeof health.agents.stale).toBe("number");
    expect(typeof health.uptime).toBe("number");
    expect(health.uptime).toBeGreaterThan(0);
  });

  it("should report healthy server in snapshot", async () => {
    const health = await hub.getHealth();
    expect(health.servers.length).toBeGreaterThanOrEqual(1);
    const server = health.servers[0];
    expect(server.healthy).toBe(true);
    expect(server.port).toBe(port);
  });

  it("should count agents correctly", async () => {
    const a1 = await connectRawAgent(port, "health-agent-1");
    const a2 = await connectRawAgent(port, "health-agent-2");
    await delay(200);

    const health = await hub.getHealth();
    expect(health.agents.total).toBe(2);
    expect(health.agents.stale).toBe(0);

    a1.close();
    a2.close();
    await delay(100);
  });

  it("should start and stop health monitor without error", async () => {
    // Start with a fast interval for testing
    hub.startHealthMonitor(500);

    // Wait for at least one health check to fire
    await delay(700);

    // Calling start again should be a no-op (idempotent)
    hub.startHealthMonitor(500);

    hub.stopHealthMonitor();

    // Calling stop again should be safe
    hub.stopHealthMonitor();
  });

  it("should emit healthCheck event from monitor", async () => {
    let received = false;
    let snapshot: any = null;
    hub.on("healthCheck", (s: any) => {
      received = true;
      snapshot = s;
    });

    hub.startHealthMonitor(200);
    await delay(500);
    hub.stopHealthMonitor();

    expect(received).toBe(true);
    expect(snapshot).toBeDefined();
    expect(snapshot).toHaveProperty("servers");
    expect(snapshot).toHaveProperty("uptime");
  });
});

// ── 4. Settings Read-Merge-Write ─────────────────────────────────────────────

describe("Settings read-merge-write", () => {
  let tmpDir: string;
  let settingsFile: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir();
    settingsFile = join(tmpDir, "settings.json");
    setSettingsPath(settingsFile);
  });

  afterEach(async () => {
    // Clean up lock files too
    await unlink(settingsFile + ".lock").catch(() => {});
    await unlink(settingsFile + ".bak").catch(() => {});
    await cleanTempDir(tmpDir);
  });

  it("should return empty object when settings file does not exist", async () => {
    const settings = await loadSettings();
    expect(settings).toEqual({});
  });

  it("should save and load settings round-trip", async () => {
    await saveSettings({ transports: { telegram: { token: "abc" } } });
    const loaded = await loadSettings();
    expect(loaded.transports).toBeDefined();
    expect(loaded.transports!.telegram).toEqual({ token: "abc" });
  });

  it("should not overwrite unrelated keys on save", async () => {
    // Write initial settings with two sections
    await saveSettings({
      transports: { telegram: { token: "t1" } },
      access: { allowlist: ["agent-a"] },
    });

    // Save a new section -- should not erase existing keys
    await saveSettings({
      state: { chatRoutes: {}, groups: {} },
    });

    const loaded = await loadSettings();
    // The transports and access sections should survive
    expect(loaded.transports).toBeDefined();
    expect(loaded.transports!.telegram).toEqual({ token: "t1" });
    expect(loaded.access).toBeDefined();
    expect(loaded.access!.allowlist).toEqual(["agent-a"]);
    // And the new state section should be present
    expect(loaded.state).toBeDefined();
  });

  it("should deep-merge transport sections", async () => {
    await saveSettings({
      transports: { telegram: { token: "t1" }, discord: { token: "d1" } },
    });

    // Save with only one transport key -- should merge, not replace
    await saveSettings({
      transports: { slack: { token: "s1" } },
    });

    const loaded = await loadSettings();
    expect(loaded.transports!.telegram).toEqual({ token: "t1" });
    expect(loaded.transports!.discord).toEqual({ token: "d1" });
    expect(loaded.transports!.slack).toEqual({ token: "s1" });
  });

  it("should deep-merge contacts section", async () => {
    await saveSettings({
      contacts: { Alice: { name: "Alice", channels: [{ type: "telegram", id: "1", url: "t://1" }] } },
    });

    await saveSettings({
      contacts: { Bob: { name: "Bob", channels: [{ type: "discord", id: "2", url: "d://2" }] } },
    });

    const loaded = await loadSettings();
    expect(loaded.contacts!["Alice"]).toBeDefined();
    expect(loaded.contacts!["Bob"]).toBeDefined();
  });

  it("should handle concurrent saves via lock without corruption", async () => {
    // Write initial data
    await saveSettings({ transports: { base: { val: 1 } } });

    // Run multiple saves concurrently
    await Promise.all([
      saveSettings({ transports: { a: { val: "a" } } }),
      saveSettings({ transports: { b: { val: "b" } } }),
      saveSettings({ transports: { c: { val: "c" } } }),
    ]);

    const loaded = await loadSettings();
    // The file should be valid JSON (not corrupted) and contain the base key
    expect(loaded.transports).toBeDefined();
    expect(loaded.transports!.base).toEqual({ val: 1 });
    // At least the last concurrent writer's key should be present
    // Due to lock serialization, all keys should merge in
    const keys = Object.keys(loaded.transports!);
    expect(keys).toContain("base");
    // At least some of a, b, c should be present (all should be, due to merge)
    const hasAll = keys.includes("a") && keys.includes("b") && keys.includes("c");
    expect(hasAll).toBe(true);
  });

  it("should create backup on save", async () => {
    await saveSettings({ transports: { first: { v: 1 } } });
    // First save won't have a backup because there's no pre-existing file to back up
    // Second save should create a backup of the first
    await saveSettings({ transports: { second: { v: 2 } } });

    const backup = JSON.parse(await readFile(settingsFile + ".bak", "utf-8"));
    // Backup should contain the state before the second save
    expect(backup.transports!.first).toEqual({ v: 1 });
  });
});
