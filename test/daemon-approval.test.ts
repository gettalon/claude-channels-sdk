/**
 * Tests for daemon status, approval/pairing flow, and per-agent config.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestHub, nextPort, connectRawAgent, delay, waitForEvent, startTestServer } from "./helpers.js";
import {
  ChannelHub,
  daemonStatus,
  loadAgentConfig,
  saveAgentConfig,
  listAgentConfigs,
} from "../dist/index.js";
import type { AgentConfig } from "../dist/index.js";
import { setSettingsPath } from "../dist/hub.js";
import { tmpdir } from "node:os";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";

// ── 1. Daemon status ──────────────────────────────────────────────────────────

describe("daemonStatus", () => {
  it("returns correct format when no daemon is running", async () => {
    const status = await daemonStatus();
    expect(status).toHaveProperty("running");
    expect(status).toHaveProperty("pid");
    expect(status).toHaveProperty("pidFile");
    expect(status).toHaveProperty("logFile");
    // In test environment there should be no daemon running
    // (pid may or may not be null depending on environment, but format is correct)
    expect(typeof status.running).toBe("boolean");
    expect(typeof status.pidFile).toBe("string");
    expect(typeof status.logFile).toBe("string");
    // If not running, pid should be null
    if (!status.running) {
      expect(status.pid).toBeNull();
    }
  });
});

// ── 2. Approval / Pairing flow ────────────────────────────────────────────────

describe("Approval / Pairing flow", () => {
  let hub: ChannelHub;
  let port: number;
  let tmpDir: string;
  let settingsFile: string;

  beforeEach(async () => {
    // Create temp dir for isolated settings
    tmpDir = await mkdtemp(join(tmpdir(), "talon-approval-test-"));
    settingsFile = join(tmpDir, "settings.json");
    setSettingsPath(settingsFile);

    port = nextPort();
    hub = createTestHub({ name: "approval-hub", port });

    // Save settings with requireApproval = true BEFORE starting server
    await hub.saveSettings({ access: { requireApproval: true } });

    await startTestServer(hub, port);
  });

  afterEach(async () => {
    // Close all agent connections
    for (const agent of hub.agents.values()) {
      try { agent.ws.close(); } catch {}
    }
    for (const [, pa] of hub.pendingAgents) {
      try { pa.ws.close(); } catch {}
    }
    // Close server
    for (const [, s] of hub.servers) {
      try { s.httpServer?.close(); s.wss?.close(); } catch {}
    }
    hub.stopHealthMonitor();
    await delay(100);

    // Restore default settings path and clean up
    setSettingsPath(join(tmpDir, "__nonexistent__"));
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it("local connections bypass requireApproval (exempt localhost)", async () => {
    const agent = await connectRawAgent(port, "local-agent");
    const ack = await agent.waitForMsg("register_ack");

    // Local connections (127.0.0.1) are always trusted
    expect(ack.status).toBe("ok");
    expect(ack.agent_id).toBeTruthy();
    expect(hub.agents.size).toBe(1);
    expect(hub.listPendingAgents().length).toBe(0);

    agent.close();
  });

  it("approveAgent completes registration and updates allowlist", async () => {
    // Manually add a pending agent (simulates remote connection)
    const { default: WebSocket } = await import("ws");
    const ws = new WebSocket(`ws://localhost:${port}`);
    await new Promise<void>((resolve) => ws.on("open", resolve));

    const code = "TEST01";
    hub.pendingAgents.set(code, {
      code, name: "remote-agent", address: "10.0.0.1",
      tools: [], ws, metadata: undefined, requestedAt: Date.now(),
    });
    expect(hub.listPendingAgents().length).toBe(1);

    const result = await hub.approveAgent(code);
    expect(result.ok).toBe(true);
    expect(result.name).toBe("remote-agent");
    expect(hub.listPendingAgents().length).toBe(0);
    expect(hub.agents.size).toBe(1);

    const settings = await hub.loadSettings();
    expect(settings.access?.allowlist).toContain("remote-agent");

    ws.close();
  });

  it("denyAgent closes connection and removes from pending", async () => {
    const { default: WebSocket } = await import("ws");
    const ws = new WebSocket(`ws://localhost:${port}`);
    await new Promise<void>((resolve) => ws.on("open", resolve));

    const code = "DENY01";
    hub.pendingAgents.set(code, {
      code, name: "deny-me", address: "10.0.0.2",
      tools: [], ws, metadata: undefined, requestedAt: Date.now(),
    });

    const result = hub.denyAgent(code);
    expect(result.ok).toBe(true);
    expect(hub.listPendingAgents().length).toBe(0);
    expect(hub.agents.size).toBe(0);

    await delay(100);
    expect(ws.readyState).toBeGreaterThanOrEqual(2);
  });

  it("approveAgent returns error for unknown code", async () => {
    const result = await hub.approveAgent("NOPE99");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("No pending agent");
  });

  it("allowlisted agent connects without approval", async () => {
    await hub.saveSettings({ access: { requireApproval: true, allowlist: ["trusted-bot"] } });
    const agent = await connectRawAgent(port, "trusted-bot");
    const ack = await agent.waitForMsg("register_ack");
    expect(ack.status).toBe("ok");
    agent.close();
  });
});

// ── 3. Per-agent config ───────────────────────────────────────────────────────

describe("Per-agent config (loadAgentConfig, saveAgentConfig, listAgentConfigs)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "talon-agentcfg-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it("round-trips a config through save then load", async () => {
    const config: AgentConfig = {
      id: "agent-abc",
      name: "test-round-trip",
      allowedChannels: ["telegram", "websocket"],
      access: {
        allowlist: ["host-1"],
        requireApproval: false,
      },
      metadata: { version: 1 },
    };

    await saveAgentConfig(config, tmpDir);
    const loaded = await loadAgentConfig("agent-abc", tmpDir);

    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe("agent-abc");
    expect(loaded!.name).toBe("test-round-trip");
    expect(loaded!.allowedChannels).toEqual(["telegram", "websocket"]);
    expect(loaded!.access?.allowlist).toEqual(["host-1"]);
    expect(loaded!.metadata).toEqual({ version: 1 });
    // Timestamps should be set
    expect(loaded!.createdAt).toBeTruthy();
    expect(loaded!.updatedAt).toBeTruthy();
  });

  it("returns null for a non-existent agent config", async () => {
    const loaded = await loadAgentConfig("no-such-agent", tmpDir);
    expect(loaded).toBeNull();
  });

  it("listAgentConfigs returns all saved configs", async () => {
    const configA: AgentConfig = { id: "agent-a", name: "Alpha" };
    const configB: AgentConfig = { id: "agent-b", name: "Beta" };
    const configC: AgentConfig = { id: "agent-c", name: "Gamma" };

    await saveAgentConfig(configA, tmpDir);
    await saveAgentConfig(configB, tmpDir);
    await saveAgentConfig(configC, tmpDir);

    const all = await listAgentConfigs(tmpDir);
    expect(all.length).toBe(3);

    const names = all.map((c) => c.name).sort();
    expect(names).toEqual(["Alpha", "Beta", "Gamma"]);
  });

  it("listAgentConfigs returns empty array for non-existent dir", async () => {
    const all = await listAgentConfigs(join(tmpDir, "nonexistent"));
    expect(all).toEqual([]);
  });

  it("saveAgentConfig overwrites existing config and updates timestamps", async () => {
    const config: AgentConfig = { id: "agent-x", name: "Original" };
    await saveAgentConfig(config, tmpDir);

    const first = await loadAgentConfig("agent-x", tmpDir);
    expect(first!.name).toBe("Original");
    const firstCreated = first!.createdAt;

    // Small delay so updatedAt is different
    await delay(10);

    // Overwrite
    const updated: AgentConfig = { id: "agent-x", name: "Updated", createdAt: firstCreated };
    await saveAgentConfig(updated, tmpDir);

    const second = await loadAgentConfig("agent-x", tmpDir);
    expect(second!.name).toBe("Updated");
    expect(second!.createdAt).toBe(firstCreated);
    expect(second!.updatedAt).toBeTruthy();
  });
});
