/**
 * Shared test helpers for ChannelHub tests.
 */
import { ChannelHub } from "../dist/index.js";
import type { HubOptions } from "../dist/index.js";
import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

let portCounter = 19100;

/** Get a unique port for each test to avoid EADDRINUSE. */
export function nextPort(): number {
  return portCounter++;
}

/** Create a temporary directory for settings isolation. */
export async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "talon-test-"));
}

/** Clean up a temp directory. */
export async function cleanTempDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}

/** Create a ChannelHub configured for testing (no auto-setup, isolated settings). */
export function createTestHub(overrides: Partial<HubOptions> & { settingsDir?: string } = {}): ChannelHub {
  const { settingsDir, ...hubOpts } = overrides;
  const hub = new ChannelHub({
    autoStart: false,
    autoConnect: false,
    autoUpdate: false,
    ...hubOpts,
  });
  return hub;
}

/** Wait for a specific event on a hub, with timeout. */
export function waitForEvent(hub: ChannelHub, event: string, timeoutMs = 5000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for event "${event}"`)), timeoutMs);
    hub.once(event, (...args: any[]) => {
      clearTimeout(timer);
      resolve(args.length === 1 ? args[0] : args);
    });
  });
}

/** Small delay helper. */
export function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Connect a raw WebSocket client to a hub server. Returns the ws and helpers. */
export async function connectRawAgent(port: number, agentName: string, tools: any[] = []): Promise<{
  ws: any;
  send: (msg: any) => void;
  waitForMsg: (type: string, timeoutMs?: number) => Promise<any>;
  messages: any[];
  close: () => void;
}> {
  const { default: WebSocket } = await import("ws");
  const ws = new WebSocket(`ws://localhost:${port}`);
  const messages: any[] = [];

  await new Promise<void>((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
  });

  ws.on("message", (data: Buffer) => {
    try { messages.push(JSON.parse(data.toString())); } catch {}
  });

  const send = (msg: any) => ws.send(JSON.stringify(msg));
  const waitForMsg = (type: string, timeoutMs = 5000): Promise<any> => {
    return new Promise((resolve, reject) => {
      // Check already received
      const existing = messages.find((m) => m.type === type);
      if (existing) {
        messages.splice(messages.indexOf(existing), 1);
        return resolve(existing);
      }
      const timer = setTimeout(() => reject(new Error(`Timeout waiting for message type "${type}"`)), timeoutMs);
      const check = setInterval(() => {
        const found = messages.find((m) => m.type === type);
        if (found) {
          clearInterval(check);
          clearTimeout(timer);
          messages.splice(messages.indexOf(found), 1);
          resolve(found);
        }
      }, 50);
    });
  };

  // Register the agent
  send({ type: "register", agent_name: agentName, tools });

  return { ws, send, waitForMsg, messages, close: () => ws.close() };
}
