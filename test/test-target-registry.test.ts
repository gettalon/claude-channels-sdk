/**
 * test-target-registry.ts — Tests for unified target registry, name resolution, and display names.
 *
 * Run: npx vitest run test/test-target-registry.ts
 */
import { describe, it, expect, beforeEach } from "vitest";
import { ChannelHub } from "../src/hub.js";

describe("Unified Target Registry", () => {
  let hub: ChannelHub;

  beforeEach(() => {
    hub = new ChannelHub({ name: "test-hub", autoStart: false, autoConnect: false, autoUpdate: false });
  });

  describe("registerTarget", () => {
    it("registers a target and returns a stable UUID", () => {
      const uuid1 = (hub as any).registerTarget("telegram", "telegram", "12345", "channel");
      const uuid2 = (hub as any).registerTarget("telegram", "telegram", "12345", "channel");
      expect(uuid1).toBe(uuid2);
      expect(uuid1).toHaveLength(12);
    });

    it("generates different UUIDs for different (channelType, rawId) pairs", () => {
      const uuid1 = (hub as any).registerTarget("telegram", "telegram", "12345", "channel");
      const uuid2 = (hub as any).registerTarget("websocket", "websocket", "12345", "channel");
      const uuid3 = (hub as any).registerTarget("telegram", "telegram", "67890", "channel");
      expect(uuid1).not.toBe(uuid2);
      expect(uuid1).not.toBe(uuid3);
      expect(uuid2).not.toBe(uuid3);
    });

    it("generates deterministic UUIDs (same inputs = same output)", () => {
      const uuid1 = (hub as any).registerTarget("agent1", "agent", "abc", "agent");
      // Create a fresh hub to verify determinism across instances
      const hub2 = new ChannelHub({ name: "test-hub-2", autoStart: false, autoConnect: false, autoUpdate: false });
      const uuid2 = (hub2 as any).registerTarget("agent1", "agent", "abc", "agent");
      expect(uuid1).toBe(uuid2);
    });

    it("stores target entry in registry", () => {
      const uuid = (hub as any).registerTarget("Home Claude", "telegram", "938185675", "user");
      const entry = hub.targetRegistry.get(uuid);
      expect(entry).toBeDefined();
      expect(entry!.name).toBe("Home Claude");
      expect(entry!.channelType).toBe("telegram");
      expect(entry!.rawId).toBe("938185675");
      expect(entry!.kind).toBe("user");
    });

    it("indexes by name (case-insensitive)", () => {
      const uuid = (hub as any).registerTarget("EchoBot", "websocket", "ws://localhost:9091", "agent");
      expect(hub.targetNameIndex.get("echobot")).toBe(uuid);
      // findTarget handles case-insensitive lookup
      expect((hub as any).findTarget("ECHOBOT")!.uuid).toBe(uuid);
      expect((hub as any).findTarget("EchoBot")!.uuid).toBe(uuid);
    });

    it("indexes by qualified name channelType:name", () => {
      const uuid = (hub as any).registerTarget("test-9091", "unix", "/tmp/talon-9091.sock", "channel");
      expect(hub.targetNameIndex.get("unix:test-9091")).toBe(uuid);
    });

    it("supports same name on different channels (e.g. telegram:agent1, websocket:agent1)", () => {
      const uuid1 = (hub as any).registerTarget("agent1", "telegram", "tg-chat-1", "agent");
      const uuid2 = (hub as any).registerTarget("agent1", "websocket", "ws-agent-1", "agent");
      // Different qualified names
      expect(hub.targetNameIndex.get("telegram:agent1")).toBe(uuid1);
      expect(hub.targetNameIndex.get("websocket:agent1")).toBe(uuid2);
      // Both stored
      expect(hub.targetRegistry.get(uuid1)!.channelType).toBe("telegram");
      expect(hub.targetRegistry.get(uuid2)!.channelType).toBe("websocket");
    });
  });

  describe("findTarget", () => {
    it("finds target by plain name (case-insensitive)", () => {
      (hub as any).registerTarget("telegram", "telegram", "bot-123", "channel");
      const found = (hub as any).findTarget("telegram");
      expect(found).toBeDefined();
      expect(found!.rawId).toBe("bot-123");
    });

    it("finds target by qualified name", () => {
      (hub as any).registerTarget("test-9091", "unix", "/tmp/talon-9091.sock", "channel");
      const found = (hub as any).findTarget("unix:test-9091");
      expect(found).toBeDefined();
      expect(found!.channelType).toBe("unix");
    });

    it("returns undefined for unknown target", () => {
      const found = (hub as any).findTarget("nonexistent");
      expect(found).toBeUndefined();
    });
  });

  describe("resolveTarget", () => {
    it("resolves registered target name to rawId", () => {
      (hub as any).registerTarget("telegram", "telegram", "938185675", "channel");
      const resolved = (hub as any).resolveTarget("telegram");
      expect(resolved).toBe("938185675");
    });

    it("resolves channel:name format", () => {
      (hub as any).registerTarget("test-9091", "unix", "/tmp/talon-9091.sock", "channel");
      const resolved = (hub as any).resolveTarget("channel:test-9091");
      expect(resolved).toBe("/tmp/talon-9091.sock");
    });

    it("resolves qualified channelType:name", () => {
      (hub as any).registerTarget("agent1", "telegram", "tg-123", "agent");
      const resolved = (hub as any).resolveTarget("telegram:agent1");
      expect(resolved).toBe("tg-123");
    });

    it("returns original when nothing matches", () => {
      const resolved = (hub as any).resolveTarget("unknown-uuid-123");
      expect(resolved).toBe("unknown-uuid-123");
    });

    it("resolves agent by name when registered", () => {
      // Manually add an agent to the agents map
      const agentId = "agent-uuid-123";
      hub.agents.set(agentId, {
        id: agentId,
        name: "echo-bot",
        tools: [],
        ws: {},
        lastHeartbeat: Date.now(),
      });
      // Also register in target registry (normally done by hub-server.ts)
      (hub as any).registerTarget("echo-bot", "agent", agentId, "agent");
      const resolved = (hub as any).resolveTarget("echo-bot");
      expect(resolved).toBe(agentId);
    });
  });

  describe("displayName", () => {
    it("returns name for registered target UUID", () => {
      (hub as any).registerTarget("Home Claude", "telegram", "938185675", "user");
      // Look up the UUID for this target
      const uuid = hub.targetNameIndex.get("home claude");
      expect(uuid).toBeDefined();
      const display = (hub as any).displayName(uuid!);
      expect(display).toBe("Home Claude");
    });

    it("returns original when target not found", () => {
      const display = (hub as any).displayName("unknown-id");
      expect(display).toBe("unknown-id");
    });

    it("returns client name when chatId matches client channel", () => {
      // Simulate a client connection
      hub.clients.set("telegram://bot", {
        id: "client-1",
        url: "telegram://bot",
        channelId: "telegram:bot",
        transport: "telegram",
        role: "channel",
        ws: {},
        name: "Telegram Bot",
      });
      const display = (hub as any).displayName("telegram:bot");
      expect(display).toBe("Telegram Bot");
    });
  });

  describe("multi-channel scenarios", () => {
    it("telegram:agent1 and telegram:agent2 have different UUIDs", () => {
      const uuid1 = (hub as any).registerTarget("agent1", "telegram", "tg-1", "agent");
      const uuid2 = (hub as any).registerTarget("agent2", "telegram", "tg-2", "agent");
      expect(uuid1).not.toBe(uuid2);
    });

    it("telegram:group1 and telegram:agent1 have different UUIDs", () => {
      const uuid1 = (hub as any).registerTarget("group1", "telegram", "grp-1", "group");
      const uuid2 = (hub as any).registerTarget("agent1", "telegram", "tg-1", "agent");
      expect(uuid1).not.toBe(uuid2);
    });

    it("channel1:agent1 and channel2:agent1 have different UUIDs (same name, different channels)", () => {
      const uuid1 = (hub as any).registerTarget("agent1", "telegram", "tg-1", "agent");
      const uuid2 = (hub as any).registerTarget("agent1", "websocket", "ws-1", "agent");
      expect(uuid1).not.toBe(uuid2);
      // Both resolve correctly
      expect((hub as any).resolveTarget("telegram:agent1")).toBe("tg-1");
      expect((hub as any).resolveTarget("websocket:agent1")).toBe("ws-1");
    });

    it("all 4 entities in same channel have unique UUIDs", () => {
      const uuids = [
        (hub as any).registerTarget("agent1", "telegram", "tg-a1", "agent"),
        (hub as any).registerTarget("agent2", "telegram", "tg-a2", "agent"),
        (hub as any).registerTarget("user1", "telegram", "tg-u1", "user"),
        (hub as any).registerTarget("group1", "telegram", "tg-g1", "group"),
      ];
      const unique = new Set(uuids);
      expect(unique.size).toBe(4);
    });
  });
});
