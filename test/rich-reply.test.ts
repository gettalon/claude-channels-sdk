/**
 * Rich reply parameters test suite.
 *
 * Verifies that format, files, buttons, and reply_to params are passed
 * through hub.reply() and hub.sendMessage() to the wire messages received
 * by agents.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestHub, nextPort, connectRawAgent, waitForEvent, delay } from "./helpers.js";
import type { ChannelHub } from "../dist/index.js";

let hub: ChannelHub;
let port: number;

describe("Rich reply parameters", () => {
  beforeEach(async () => {
    port = nextPort();
    hub = createTestHub({ name: "rich-test-server", port });
    await hub.startServer(port);
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

  // ── reply() with rich params ─────────────────────────────────────────

  it("should pass format through reply()", async () => {
    const agent = await connectRawAgent(port, "fmt-agent");
    await agent.waitForMsg("register_ack");

    const agentState = hub.findAgent("fmt-agent")!;
    hub.handover("chat-fmt", agentState.id);
    await agent.waitForMsg("chat"); // consume handover system msg

    const result = hub.reply("chat-fmt", "Hello **bold**", { format: "markdown" });
    expect(result.ok).toBe(true);

    const msg = await agent.waitForMsg("chat");
    expect(msg.content).toBe("Hello **bold**");
    expect(msg.format).toBe("markdown");

    agent.close();
  });

  it("should pass files through reply()", async () => {
    const agent = await connectRawAgent(port, "file-agent");
    await agent.waitForMsg("register_ack");

    const agentState = hub.findAgent("file-agent")!;
    hub.handover("chat-file", agentState.id);
    await agent.waitForMsg("chat");

    const files = [{ name: "report.pdf", url: "https://example.com/report.pdf", mime: "application/pdf" }];
    const result = hub.reply("chat-file", "Here is the report", { files });
    expect(result.ok).toBe(true);

    const msg = await agent.waitForMsg("chat");
    expect(msg.content).toBe("Here is the report");
    expect(msg.files).toEqual(files);

    agent.close();
  });

  it("should pass buttons through reply()", async () => {
    const agent = await connectRawAgent(port, "btn-agent");
    await agent.waitForMsg("register_ack");

    const agentState = hub.findAgent("btn-agent")!;
    hub.handover("chat-btn", agentState.id);
    await agent.waitForMsg("chat");

    const buttons = [
      { text: "Approve", action: "approve" },
      { text: "Visit Docs", url: "https://docs.example.com" },
    ];
    const result = hub.reply("chat-btn", "Choose an option", { buttons });
    expect(result.ok).toBe(true);

    const msg = await agent.waitForMsg("chat");
    expect(msg.content).toBe("Choose an option");
    expect(msg.buttons).toEqual(buttons);

    agent.close();
  });

  it("should pass reply_to through reply()", async () => {
    const agent = await connectRawAgent(port, "thread-agent");
    await agent.waitForMsg("register_ack");

    const agentState = hub.findAgent("thread-agent")!;
    hub.handover("chat-thread", agentState.id);
    await agent.waitForMsg("chat");

    const result = hub.reply("chat-thread", "Threaded reply", { reply_to: "msg-42" });
    expect(result.ok).toBe(true);

    const msg = await agent.waitForMsg("chat");
    expect(msg.content).toBe("Threaded reply");
    expect(msg.reply_to).toBe("msg-42");

    agent.close();
  });

  it("should pass all rich params together through reply()", async () => {
    const agent = await connectRawAgent(port, "all-agent");
    await agent.waitForMsg("register_ack");

    const agentState = hub.findAgent("all-agent")!;
    hub.handover("chat-all", agentState.id);
    await agent.waitForMsg("chat");

    const rich = {
      format: "html" as const,
      files: [{ name: "img.png", data: "iVBOR...", mime: "image/png" }],
      buttons: [{ text: "OK", action: "confirm" }],
      reply_to: "msg-99",
    };
    const result = hub.reply("chat-all", "<b>All params</b>", rich);
    expect(result.ok).toBe(true);

    const msg = await agent.waitForMsg("chat");
    expect(msg.content).toBe("<b>All params</b>");
    expect(msg.format).toBe("html");
    expect(msg.files).toEqual(rich.files);
    expect(msg.buttons).toEqual(rich.buttons);
    expect(msg.reply_to).toBe("msg-99");

    agent.close();
  });

  // ── sendMessage() with rich params ───────────────────────────────────

  it("should pass format through sendMessage()", async () => {
    const agent = await connectRawAgent(port, "sm-fmt-agent");
    await agent.waitForMsg("register_ack");

    const result = hub.sendMessage("sm-fmt-agent", "Hello <i>italic</i>", { format: "html" });
    expect(result.ok).toBe(true);

    const msg = await agent.waitForMsg("chat");
    expect(msg.content).toBe("Hello <i>italic</i>");
    expect(msg.format).toBe("html");

    agent.close();
  });

  it("should pass files through sendMessage()", async () => {
    const agent = await connectRawAgent(port, "sm-file-agent");
    await agent.waitForMsg("register_ack");

    const files = [{ name: "data.csv", path: "/tmp/data.csv" }];
    const result = hub.sendMessage("sm-file-agent", "Data attached", { files });
    expect(result.ok).toBe(true);

    const msg = await agent.waitForMsg("chat");
    expect(msg.content).toBe("Data attached");
    expect(msg.files).toEqual(files);

    agent.close();
  });

  it("should pass buttons and reply_to through sendMessage()", async () => {
    const agent = await connectRawAgent(port, "sm-btn-agent");
    await agent.waitForMsg("register_ack");

    const buttons = [{ text: "Yes" }, { text: "No" }];
    const result = hub.sendMessage("sm-btn-agent", "Confirm?", { buttons, reply_to: "msg-7" });
    expect(result.ok).toBe(true);

    const msg = await agent.waitForMsg("chat");
    expect(msg.content).toBe("Confirm?");
    expect(msg.buttons).toEqual(buttons);
    expect(msg.reply_to).toBe("msg-7");

    agent.close();
  });

  // ── reply() to a direct agent (no handover route) ────────────────────

  it("should pass rich params through reply() to a direct agent", async () => {
    const agent = await connectRawAgent(port, "direct-agent");
    await agent.waitForMsg("register_ack");

    const result = hub.reply("direct-agent", "Direct rich reply", { format: "markdown", reply_to: "msg-1" });
    expect(result.ok).toBe(true);

    const msg = await agent.waitForMsg("reply");
    expect(msg.text).toBe("Direct rich reply");
    expect(msg.format).toBe("markdown");
    expect(msg.reply_to).toBe("msg-1");

    agent.close();
  });

  // ── Without rich params (backwards compatibility) ────────────────────

  it("should work without rich params (backwards compat)", async () => {
    const agent = await connectRawAgent(port, "compat-agent");
    await agent.waitForMsg("register_ack");

    const result = hub.sendMessage("compat-agent", "Plain message");
    expect(result.ok).toBe(true);

    const msg = await agent.waitForMsg("chat");
    expect(msg.content).toBe("Plain message");
    expect(msg.format).toBeUndefined();
    expect(msg.files).toBeUndefined();
    expect(msg.buttons).toBeUndefined();
    expect(msg.reply_to).toBeUndefined();

    agent.close();
  });
});
