/**
 * Streaming protocol test suite.
 *
 * Tests STREAM_START, STREAM_CHUNK, and STREAM_END message flow
 * through the ChannelHub server between agents.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestHub, nextPort, connectRawAgent, waitForEvent, delay } from "./helpers.js";
import type { ChannelHub } from "../dist/index.js";

let hub: ChannelHub;
let port: number;

describe("Streaming Protocol", () => {
  beforeEach(async () => {
    port = nextPort();
    hub = createTestHub({ name: "stream-server", port });
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

  // ── Stream lifecycle ──────────────────────────────────────────────────

  it("should forward STREAM_START to other agents", async () => {
    const sender = await connectRawAgent(port, "stream-sender");
    const receiver = await connectRawAgent(port, "stream-receiver");
    await sender.waitForMsg("register_ack");
    await receiver.waitForMsg("register_ack");

    sender.send({
      type: "stream_start",
      stream_id: "s1",
      content_type: "text",
      meta: { source: "llm" },
    });

    const msg = await receiver.waitForMsg("stream_start");
    expect(msg.type).toBe("stream_start");
    expect(msg.stream_id).toBe("s1");
    expect(msg.content_type).toBe("text");
    expect(msg.meta?.source).toBe("llm");

    sender.close();
    receiver.close();
  });

  it("should forward STREAM_CHUNK with sequence numbers", async () => {
    const sender = await connectRawAgent(port, "chunk-sender");
    const receiver = await connectRawAgent(port, "chunk-receiver");
    await sender.waitForMsg("register_ack");
    await receiver.waitForMsg("register_ack");

    sender.send({ type: "stream_start", stream_id: "s2", content_type: "text" });
    await receiver.waitForMsg("stream_start");

    sender.send({ type: "stream_chunk", stream_id: "s2", data: "Hello ", seq: 0 });
    sender.send({ type: "stream_chunk", stream_id: "s2", data: "world!", seq: 1 });

    const chunk0 = await receiver.waitForMsg("stream_chunk");
    expect(chunk0.stream_id).toBe("s2");
    expect(chunk0.data).toBe("Hello ");
    expect(chunk0.seq).toBe(0);

    const chunk1 = await receiver.waitForMsg("stream_chunk");
    expect(chunk1.data).toBe("world!");
    expect(chunk1.seq).toBe(1);

    sender.close();
    receiver.close();
  });

  it("should forward STREAM_END to other agents", async () => {
    const sender = await connectRawAgent(port, "end-sender");
    const receiver = await connectRawAgent(port, "end-receiver");
    await sender.waitForMsg("register_ack");
    await receiver.waitForMsg("register_ack");

    sender.send({ type: "stream_start", stream_id: "s3", content_type: "audio" });
    await receiver.waitForMsg("stream_start");

    sender.send({ type: "stream_end", stream_id: "s3", meta: { duration: "5.2s" } });
    const end = await receiver.waitForMsg("stream_end");
    expect(end.stream_id).toBe("s3");
    expect(end.meta?.duration).toBe("5.2s");

    sender.close();
    receiver.close();
  });

  // ── Full stream lifecycle ─────────────────────────────────────────────

  it("should handle a complete text stream (start + chunks + end)", async () => {
    const sender = await connectRawAgent(port, "full-sender");
    const receiver = await connectRawAgent(port, "full-receiver");
    await sender.waitForMsg("register_ack");
    await receiver.waitForMsg("register_ack");

    // Start
    sender.send({ type: "stream_start", stream_id: "full-1", content_type: "text", meta: { model: "claude-4" } });
    const start = await receiver.waitForMsg("stream_start");
    expect(start.content_type).toBe("text");

    // Chunks
    const tokens = ["The ", "quick ", "brown ", "fox"];
    for (let i = 0; i < tokens.length; i++) {
      sender.send({ type: "stream_chunk", stream_id: "full-1", data: tokens[i], seq: i });
    }

    for (let i = 0; i < tokens.length; i++) {
      const chunk = await receiver.waitForMsg("stream_chunk");
      expect(chunk.seq).toBe(i);
      expect(chunk.data).toBe(tokens[i]);
    }

    // End
    sender.send({ type: "stream_end", stream_id: "full-1", meta: { total_tokens: "4" } });
    const end = await receiver.waitForMsg("stream_end");
    expect(end.stream_id).toBe("full-1");
    expect(end.meta?.total_tokens).toBe("4");

    sender.close();
    receiver.close();
  });

  // ── Targeted stream ──────────────────────────────────────────────────

  it("should forward targeted stream only to specified agent", async () => {
    const sender = await connectRawAgent(port, "target-sender");
    const receiver1 = await connectRawAgent(port, "target-recv-1");
    const receiver2 = await connectRawAgent(port, "target-recv-2");
    await sender.waitForMsg("register_ack");
    await receiver1.waitForMsg("register_ack");
    await receiver2.waitForMsg("register_ack");

    // Send targeted stream to receiver1 only
    sender.send({ type: "stream_start", stream_id: "t1", content_type: "file", target: "target-recv-1" });
    const msg = await receiver1.waitForMsg("stream_start");
    expect(msg.stream_id).toBe("t1");

    // receiver2 should NOT get the message — wait briefly and check
    await delay(200);
    const stray = receiver2.messages.find((m: any) => m.type === "stream_start");
    expect(stray).toBeUndefined();

    sender.close();
    receiver1.close();
    receiver2.close();
  });

  // ── Hub "stream" event ────────────────────────────────────────────────

  it("should emit 'stream' event on the hub for each stream message", async () => {
    const agent = await connectRawAgent(port, "event-agent");
    await agent.waitForMsg("register_ack");

    const events: any[] = [];
    hub.on("stream", (msg: any) => events.push(msg));

    agent.send({ type: "stream_start", stream_id: "ev-1", content_type: "video" });
    agent.send({ type: "stream_chunk", stream_id: "ev-1", data: "AAAA", seq: 0 });
    agent.send({ type: "stream_end", stream_id: "ev-1" });

    await delay(300);

    expect(events).toHaveLength(3);
    expect(events[0].type).toBe("stream_start");
    expect(events[1].type).toBe("stream_chunk");
    expect(events[2].type).toBe("stream_end");

    agent.close();
  });

  // ── Binary/base64 streaming ──────────────────────────────────────────

  it("should stream base64-encoded file data", async () => {
    const sender = await connectRawAgent(port, "b64-sender");
    const receiver = await connectRawAgent(port, "b64-receiver");
    await sender.waitForMsg("register_ack");
    await receiver.waitForMsg("register_ack");

    const b64Chunk = Buffer.from("Hello binary world!").toString("base64");

    sender.send({ type: "stream_start", stream_id: "b64-1", content_type: "file", meta: { filename: "test.bin", mime: "application/octet-stream" } });
    await receiver.waitForMsg("stream_start");

    sender.send({ type: "stream_chunk", stream_id: "b64-1", data: b64Chunk, seq: 0 });
    const chunk = await receiver.waitForMsg("stream_chunk");
    expect(chunk.data).toBe(b64Chunk);

    // Decode and verify
    const decoded = Buffer.from(chunk.data, "base64").toString("utf-8");
    expect(decoded).toBe("Hello binary world!");

    sender.send({ type: "stream_end", stream_id: "b64-1" });
    await receiver.waitForMsg("stream_end");

    sender.close();
    receiver.close();
  });

  // ── Sender does not receive own stream messages ──────────────────────

  it("should not echo stream messages back to the sender", async () => {
    const sender = await connectRawAgent(port, "echo-sender");
    const receiver = await connectRawAgent(port, "echo-receiver");
    await sender.waitForMsg("register_ack");
    await receiver.waitForMsg("register_ack");

    sender.send({ type: "stream_start", stream_id: "echo-1", content_type: "text" });
    sender.send({ type: "stream_chunk", stream_id: "echo-1", data: "token", seq: 0 });
    sender.send({ type: "stream_end", stream_id: "echo-1" });

    // Wait for receiver to get all three
    await receiver.waitForMsg("stream_start");
    await receiver.waitForMsg("stream_chunk");
    await receiver.waitForMsg("stream_end");

    // Sender should NOT have received any stream messages back
    await delay(200);
    const echoedStart = sender.messages.find((m: any) => m.type === "stream_start");
    const echoedChunk = sender.messages.find((m: any) => m.type === "stream_chunk");
    const echoedEnd = sender.messages.find((m: any) => m.type === "stream_end");
    expect(echoedStart).toBeUndefined();
    expect(echoedChunk).toBeUndefined();
    expect(echoedEnd).toBeUndefined();

    sender.close();
    receiver.close();
  });
});
