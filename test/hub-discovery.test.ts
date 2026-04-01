/**
 * Hub discovery tests.
 *
 * Verifies that:
 * 1. Discovery payload always includes the hub itself as an agent
 * 2. connect tool receives remoteInfo via approvalGranted event (not stale settings)
 * 3. msg.target falls through to routeChat when targeting the hub name
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestHub, nextPort, delay, startTestServer } from "./helpers.js";
import type { ChannelHub } from "../dist/index.js";

let serverHub: ChannelHub;
let clientHub: ChannelHub;
let port: number;
let wsUrl: string;

describe("Hub discovery", () => {
  beforeEach(async () => {
    port = nextPort();
    wsUrl = `ws://localhost:${port}`;
    serverHub = createTestHub({ name: "my-hub", port });
    await startTestServer(serverHub, port);
    clientHub = createTestHub({ name: "client-hub", port, agentName: "remote-client", preferLocalIpc: false });
  });

  afterEach(async () => {
    clientHub?.stopHealthMonitor();
    serverHub?.stopHealthMonitor();
    for (const [, c] of clientHub.clients) { try { c.ws.close(); } catch {} }
    for (const agent of serverHub.agents.values()) { try { agent.ws.close(); } catch {} }
    for (const [, s] of serverHub.servers) { try { s.httpServer?.close(); (s as any).wss?.close(); } catch {} }
    await delay(100);
  });

  // ── Hub self-registration in discovery ────────────────────────────────

  it("register_ack info includes hub itself as first agent", async () => {
    const ackPromise = new Promise<any>((resolve) => {
      clientHub.once("approvalGranted", resolve);
    });
    await clientHub.connect(wsUrl, "remote-client");
    const ev = await ackPromise;

    expect(ev.info).toBeDefined();
    const agents: any[] = ev.info.agents ?? [];
    expect(agents[0]).toMatchObject({ id: "hub", name: "my-hub" });
  });

  it("hub agent is always present even with no other agents connected", async () => {
    const ackPromise = new Promise<any>((resolve) => {
      clientHub.once("approvalGranted", resolve);
    });
    await clientHub.connect(wsUrl, "remote-client");
    const ev = await ackPromise;

    // Only agent should be the hub itself (remote-client is excluded as self)
    expect(ev.info.agents).toContainEqual(expect.objectContaining({ id: "hub", name: "my-hub" }));
  });

  // ── connect tool: remoteInfo arrives via event ────────────────────────

  it("approvalGranted event fires with info before settings are read", async () => {
    let capturedInfo: any;
    const ackPromise = new Promise<void>((resolve) => {
      clientHub.once("approvalGranted", (ev) => { capturedInfo = ev.info; resolve(); });
    });

    await clientHub.connect(wsUrl, "remote-client");
    await Promise.race([ackPromise, new Promise<void>(r => setTimeout(r, 3000))]);

    expect(capturedInfo).toBeDefined();
    expect(capturedInfo.server_name).toBe("my-hub");
    expect(capturedInfo.agents).toContainEqual(expect.objectContaining({ id: "hub", name: "my-hub" }));
  });

  // ── msg.target fallthrough to hub ────────────────────────────────────

  it("message targeting hub name is delivered to hub via routeChat", async () => {
    await clientHub.connect(wsUrl, "remote-client");
    await delay(200);

    const received = new Promise<any>((resolve) => {
      serverHub.on("message", resolve);
    });

    // Send from the client to the server targeting the hub by name
    const clientConn = [...clientHub.clients.values()][0];
    clientConn.ws.send(JSON.stringify({
      type: "chat",
      chat_id: "test-chat",
      content: "hello hub",
      from: "remote-client",
      target: "my-hub",
    }));

    const msg = await received;
    expect(msg.content).toBe("hello hub");
  });

  it("message targeting 'hub' literal falls through to routeChat", async () => {
    await clientHub.connect(wsUrl, "remote-client");
    await delay(200);

    const received = new Promise<any>((resolve) => {
      serverHub.on("message", resolve);
    });

    const clientConn = [...clientHub.clients.values()][0];
    clientConn.ws.send(JSON.stringify({
      type: "chat",
      chat_id: "test-chat",
      content: "ping",
      from: "remote-client",
      target: "hub",
    }));

    const msg = await received;
    expect(msg.content).toBe("ping");
  });
});
