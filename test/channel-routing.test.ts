/**
 * Tests for channel reply routing: channelForChat tracking, wsSendAsync, multi-channel.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestHub } from "./helpers.js";
import type { ChannelHub } from "../dist/index.js";

describe("channel reply routing", () => {
  let hub: ChannelHub;

  beforeEach(() => {
    hub = createTestHub({ name: "test-hub" });
  });

  describe("channelForChat tracking", () => {
    it("should populate channelForChat when channel message arrives via hub-client handler", () => {
      // Simulate a channel client entry
      const fakeWs = { send: () => {}, readyState: 1, close: () => {} };
      (hub as any).clients.set("telegram://bot", {
        id: "tg-1",
        url: "telegram://bot",
        channelId: "telegram:bot",
        transport: "telegram",
        role: "channel",
        ws: fakeWs,
        name: "telegram",
      });

      // channelForChat should be empty initially
      expect(hub.channelForChat.size).toBe(0);

      // Simulate routeChat with source: "channel"
      (hub as any).routeChat({
        chatId: "12345",
        content: "hello",
        from: "user1",
        source: "channel",
      });

      // Should now track the channel for this chatId
      expect(hub.channelForChat.has("12345")).toBe(true);
      expect(hub.channelForChat.get("12345")?.transport).toBe("telegram");
    });

    it("should not overwrite existing channelForChat entries", () => {
      const fakeWsTelegram = { send: () => {}, readyState: 1, close: () => {} };
      const fakeWsDiscord = { send: () => {}, readyState: 1, close: () => {} };

      (hub as any).clients.set("telegram://bot", {
        id: "tg-1", url: "telegram://bot", channelId: "telegram:bot",
        transport: "telegram", role: "channel", ws: fakeWsTelegram, name: "telegram",
      });
      (hub as any).clients.set("discord://bot", {
        id: "dc-1", url: "discord://bot", channelId: "discord:bot",
        transport: "discord", role: "channel", ws: fakeWsDiscord, name: "discord",
      });

      // First message from telegram
      (hub as any).routeChat({ chatId: "12345", content: "hi", from: "user1", source: "channel" });
      expect(hub.channelForChat.get("12345")?.transport).toBe("telegram");

      // Second message should not overwrite
      (hub as any).routeChat({ chatId: "12345", content: "hi again", from: "user1", source: "channel" });
      expect(hub.channelForChat.get("12345")?.transport).toBe("telegram");
    });
  });

  describe("reply() routing", () => {
    it("should route reply through known channel client", () => {
      const sent: any[] = [];
      const fakeWs = { send: (data: string) => sent.push(JSON.parse(data)), readyState: 1, close: () => {} };

      (hub as any).clients.set("telegram://bot", {
        id: "tg-1", url: "telegram://bot", channelId: "telegram:bot",
        transport: "telegram", role: "channel", ws: fakeWs, name: "telegram",
      });

      // Pre-populate channelForChat
      hub.channelForChat.set("12345", (hub as any).clients.get("telegram://bot"));

      const result = hub.reply("12345", "hello back");
      expect(result.ok).toBe(true);
      expect(sent.length).toBe(1);
      expect(sent[0].type).toBe("reply");
      expect(sent[0].chat_id).toBe("12345");
      expect(sent[0].content).toBe("hello back");
    });

    it("should fall back to any channel client when channelForChat is empty", () => {
      const sent: any[] = [];
      const fakeWs = { send: (data: string) => sent.push(JSON.parse(data)), readyState: 1, close: () => {} };

      (hub as any).clients.set("telegram://bot", {
        id: "tg-1", url: "telegram://bot", channelId: "telegram:bot",
        transport: "telegram", role: "channel", ws: fakeWs, name: "telegram",
      });

      const result = hub.reply("99999", "hello");
      expect(result.ok).toBe(true);
      expect(sent.length).toBe(1);
      expect(sent[0].chat_id).toBe("99999");
    });

    it("should return No route when no channel clients exist", () => {
      const result = hub.reply("12345", "hello");
      expect(result.ok).toBe(false);
      expect(result.error).toBe("No route");
    });
  });

  describe("sendMessage() routing", () => {
    it("should route through channelForChat before getClientWs", () => {
      const channelSent: any[] = [];
      const serverSent: any[] = [];
      const channelWs = { send: (data: string) => channelSent.push(JSON.parse(data)), readyState: 1, close: () => {} };
      const serverWs = { send: (data: string) => serverSent.push(JSON.parse(data)), readyState: 1, close: () => {} };

      (hub as any).clients.set("telegram://bot", {
        id: "tg-1", url: "telegram://bot", channelId: "telegram:bot",
        transport: "telegram", role: "channel", ws: channelWs, name: "telegram",
      });
      (hub as any).clients.set("unix:///tmp/test.sock", {
        id: "srv-1", url: "unix:///tmp/test.sock", channelId: "unix:/tmp/test.sock",
        transport: "unix", role: "server", ws: serverWs, name: "server",
      });

      // Set channelForChat
      hub.channelForChat.set("12345", (hub as any).clients.get("telegram://bot"));

      const result = hub.sendMessage("12345", "test message");
      expect(result.ok).toBe(true);
      // Should go to channel, not server
      expect(channelSent.length).toBe(1);
      expect(serverSent.length).toBe(0);
    });
  });

  describe("Telegram group reply routing (bug fix)", () => {
    it("should route reply to Telegram channel, not to MCP client, when agent contact shadows chat_id", () => {
      const channelSent: any[] = [];
      const serverSent: any[] = [];
      const channelWs = { send: (data: string) => channelSent.push(JSON.parse(data)), readyState: 1, close: () => {} };
      const serverWs = { send: (data: string) => serverSent.push(JSON.parse(data)), readyState: 1, close: () => {} };

      // Set up a Telegram channel client and a server (MCP) client
      (hub as any).clients.set("telegram://bot", {
        id: "tg-1", url: "telegram://bot", channelId: "telegram:bot",
        transport: "telegram", role: "channel", ws: channelWs, name: "telegram",
      });
      (hub as any).clients.set("unix:///tmp/test.sock", {
        id: "srv-1", url: "unix:///tmp/test.sock", channelId: "unix:/tmp/test.sock",
        transport: "unix", role: "server", ws: serverWs, name: "server",
      });

      const chatId = "-5248969704"; // Telegram group chat ID

      // Simulate the bug scenario: an agent named "talon" was auto-registered as
      // a contact with type "agent" and the Telegram group chat_id.
      // This happens when the hub's own agent processes messages from this group.
      hub.registerContact("talon", "agent", chatId);

      // Also register the real user's contact with type "telegram"
      hub.registerContact("user1", "telegram", chatId);

      // Pre-populate channelForChat (happens when messages arrive from Telegram)
      hub.channelForChat.set(chatId, (hub as any).clients.get("telegram://bot"));

      // resolveContact by chat_id should prefer non-agent channel
      const resolved = hub.resolveContact(chatId);
      expect(resolved).toBeDefined();
      expect(resolved!.channel.type).toBe("telegram");
      expect(resolved!.contact.name).toBe("user1");

      // sendMessage should route to Telegram, not to MCP server
      const result = hub.sendMessage(chatId, "reply to group");
      expect(result.ok).toBe(true);
      expect(channelSent.length).toBe(1);
      expect(channelSent[0].chat_id).toBe(chatId);
      expect(channelSent[0].content).toBe("reply to group");
      expect(serverSent.length).toBe(0);
    });

    it("should not auto-register known agents as contacts with type 'agent'", async () => {
      const fakeWs = { send: () => {}, readyState: 1, close: () => {} };

      // Register a fake agent named "talon"
      (hub as any).agents.set("agent-id-1", {
        id: "agent-id-1", name: "talon", ws: fakeWs,
        tools: [], status: "ready",
      });

      // autoRegisterContact should skip "talon" with type "agent"
      (hub as any).autoRegisterContact("talon", "-5248969704", "agent");
      const contact = hub.resolveContact("talon");
      expect(contact).toBeUndefined();

      // But it should still register non-agent contacts
      (hub as any).autoRegisterContact("talon", "-5248969704", "telegram");
      const contact2 = hub.resolveContact("talon");
      expect(contact2).toBeDefined();
      expect(contact2!.channel.type).toBe("telegram");

      // Clean up
      (hub as any).agents.delete("agent-id-1");
    });

    it("send tool should skip agent-type contacts and route via channel transport", () => {
      const channelSent: any[] = [];
      const channelWs = { send: (data: string) => channelSent.push(JSON.parse(data)), readyState: 1, close: () => {} };

      (hub as any).clients.set("telegram://bot", {
        id: "tg-1", url: "telegram://bot", channelId: "telegram:bot",
        transport: "telegram", role: "channel", ws: channelWs, name: "telegram",
      });

      const chatId = "-5248969704";

      // Only an agent-type contact exists (no telegram contact)
      hub.registerContact("talon", "agent", chatId);
      hub.channelForChat.set(chatId, (hub as any).clients.get("telegram://bot"));

      // resolveContact by chatId returns agent-type
      const contact = hub.resolveContact(chatId);
      expect(contact).toBeDefined();
      expect(contact!.channel.type).toBe("agent");

      // But reply should still go through the Telegram channel
      const result = hub.reply(chatId, "hello group");
      expect(result.ok).toBe(true);
      expect(channelSent.length).toBe(1);
      expect(channelSent[0].chat_id).toBe(chatId);
    });
  });

  describe("wsSendAsync", () => {
    it("should catch async Promise rejections", async () => {
      const errors: string[] = [];
      const origWrite = process.stderr.write;
      process.stderr.write = ((chunk: any) => { errors.push(String(chunk)); return true; }) as any;

      const fakeWs = {
        send: () => Promise.reject(new Error("Telegram API error")),
      };

      (hub as any).wsSendAsync(fakeWs, { type: "test" });
      // Wait for the rejection to be caught
      await new Promise(r => setTimeout(r, 50));

      process.stderr.write = origWrite;
      expect(errors.some(e => e.includes("wsSendAsync error"))).toBe(true);
    });

    it("should handle sync errors", () => {
      const errors: string[] = [];
      const origWrite = process.stderr.write;
      process.stderr.write = ((chunk: any) => { errors.push(String(chunk)); return true; }) as any;

      const fakeWs = {
        send: () => { throw new Error("sync error"); },
      };

      (hub as any).wsSendAsync(fakeWs, { type: "test" });

      process.stderr.write = origWrite;
      expect(errors.some(e => e.includes("wsSendAsync error"))).toBe(true);
    });
  });
});
