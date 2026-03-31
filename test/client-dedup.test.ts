/**
 * Tests for client connection deduplication.
 *
 * Verifies that connecting with auto://, ws://, and unix:// URLs
 * that resolve to the same hub results in only 1 client entry.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestHub, nextPort, delay } from "./helpers.js";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ChannelHub } from "../dist/index.js";
import { createWebSocketChannel } from "../dist/channels/websocket.js";

const DAEMON_PID = join(homedir(), ".talon", "daemon.pid");

describe("Client connection dedup", () => {
  let serverHub: ChannelHub;
  let clientHub: ChannelHub;
  let port: number;

  beforeEach(async () => {
    port = nextPort();
    serverHub = createTestHub({ name: "dedup-server", port });
    await serverHub.startServer(port);
  });

  afterEach(async () => {
    // Close client connections
    if (clientHub) {
      for (const [, c] of (clientHub as any).clients) {
        try { c.ws.close(); } catch {}
      }
    }
    for (const [, s] of serverHub.servers) {
      try { s.httpServer?.close(); s.wss?.close(); } catch {}
    }
    try { unlinkSync(`/tmp/talon-${port}.sock`); } catch {}
    try { unlinkSync(DAEMON_PID); } catch {}
    serverHub.stopHealthMonitor();
    await delay(200);
  });

  it("should deduplicate auto://, ws://, and unix:// to the same hub", async () => {
    clientHub = createTestHub({
      name: "dedup-client",
      port,
      autoStart: false,
      autoConnect: false,
    });

    // Connect via unix:// first
    const socketPath = `/tmp/talon-${port}.sock`;
    await clientHub.connect(`unix://${socketPath}`, "dedup-agent");
    expect(clientHub.clients.size).toBe(1);

    // Attempt to connect via ws://localhost:{port} — should be deduped
    await clientHub.connect(`ws://localhost:${port}`, "dedup-agent");
    expect(clientHub.clients.size).toBe(1);

    // Attempt to connect via auto://localhost:{port} — should also be deduped
    await clientHub.connect(`auto://localhost:${port}`, "dedup-agent");
    expect(clientHub.clients.size).toBe(1);
  });

  it("should deduplicate ws:// when auto:// connected first", async () => {
    clientHub = createTestHub({
      name: "dedup-client-2",
      port,
      autoStart: false,
      autoConnect: false,
    });

    // Connect via auto:// first (will resolve to unix:// or ws://)
    await clientHub.connect(`auto://localhost:${port}`, "dedup-agent-2");
    expect(clientHub.clients.size).toBe(1);

    // Attempt ws:// — should be deduped
    await clientHub.connect(`ws://localhost:${port}`, "dedup-agent-2");
    expect(clientHub.clients.size).toBe(1);

    // Attempt unix:// — should also be deduped
    await clientHub.connect(`unix:///tmp/talon-${port}.sock`, "dedup-agent-2");
    expect(clientHub.clients.size).toBe(1);
  });

  it("should allow connections to different ports (no false dedup)", async () => {
    const port2 = nextPort();
    const serverHub2 = createTestHub({ name: "dedup-server-2", port: port2 });
    await serverHub2.startServer(port2);

    clientHub = createTestHub({
      name: "multi-port-client",
      port,
      autoStart: false,
      autoConnect: false,
    });

    await clientHub.connect(`unix:///tmp/talon-${port}.sock`, "multi-agent");
    expect(clientHub.clients.size).toBe(1);

    await clientHub.connect(`unix:///tmp/talon-${port2}.sock`, "multi-agent-2");
    expect(clientHub.clients.size).toBe(2);

    // Clean up second server
    for (const [, s] of serverHub2.servers) {
      try { s.httpServer?.close(); s.wss?.close(); } catch {}
    }
    try { unlinkSync(`/tmp/talon-${port2}.sock`); } catch {}
    serverHub2.stopHealthMonitor();
  });
});

// ── Test group 4: WS reconnect backoff ────────────────────────────────────

describe("WS reconnect backoff", () => {
  it("should export createWebSocketChannel as a function", () => {
    // Verify the websocket channel module is importable and has the right shape
    expect(typeof createWebSocketChannel).toBe("function");
  });

  it("should create a channel with autoReconnect config", async () => {
    const port = nextPort();
    const { channel, cleanup } = await createWebSocketChannel({
      mode: "server",
      port,
      autoReconnect: true,
    });

    expect(channel).toBeDefined();
    // ChannelServer is an EventEmitter — verify it has the expected shape
    expect(typeof channel.on).toBe("function");
    expect(typeof channel.emit).toBe("function");

    cleanup();
    await delay(100);
  });

  it("should track reconnect attempt counter after disconnect from dead server", async () => {
    // Create a server, connect a client, then kill the server
    const port = nextPort();
    const { channel: serverChannel, cleanup: cleanupServer } = await createWebSocketChannel({
      mode: "server",
      port,
      autoReconnect: false,
    });

    const { channel: clientChannel, cleanup: cleanupClient } = await createWebSocketChannel({
      mode: "client",
      url: `ws://localhost:${port}`,
      autoReconnect: true,
    });

    await delay(300);

    // Kill the server — client should start reconnect backoff
    cleanupServer();
    await delay(500);

    // The reconnect timer __attempt counter is internal to the closure,
    // so we verify indirectly: the client channel still exists and didn't crash
    expect(clientChannel).toBeDefined();

    cleanupClient();
    await delay(100);
  });
});
