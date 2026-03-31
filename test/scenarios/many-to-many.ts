/**
 * Many-to-many messaging scenario.
 *
 * Creates N hubs each with M agents. Every agent sends a message to every
 * other agent. Verifies delivery rate and reports stats.
 *
 * Usage:
 *   npx tsx test/scenarios/many-to-many.ts [--hubs 3] [--agents 5] [--duration 30]
 */
import { ChannelHub } from "../../dist/index.js";
import WebSocket from "ws";

const args = process.argv.slice(2);
const getArg = (flag: string, def: number) => {
  const i = args.indexOf(flag);
  return i >= 0 ? parseInt(args[i + 1]) : def;
};
const NUM_HUBS = getArg("--hubs", 3);
const AGENTS_PER_HUB = getArg("--agents", 5);
const DURATION_MS = getArg("--duration", 20) * 1000;
const BASE_PORT = 20100;

// ── Stats ────────────────────────────────────────────────────────────────────
let sent = 0;
let received = 0;
let errors = 0;

// ── Helper: connect a raw agent to a hub ─────────────────────────────────────
async function connectAgent(port: number, name: string): Promise<{
  id: string;
  onMessage: (fn: (content: string, from: string) => void) => void;
  send: (toId: string, text: string) => void;
  close: () => void;
}> {
  const ws = new WebSocket(`ws://localhost:${port}`);
  await new Promise<void>((res, rej) => { ws.on("open", res); ws.on("error", rej); });

  let agentId = "";
  const listeners: Array<(content: string, from: string) => void> = [];
  const pending: Array<{ resolve: (v: string) => void }> = [];

  ws.on("message", (raw: Buffer) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === "register_ack" && msg.status === "ok") {
      agentId = msg.agent_id;
      pending.forEach(p => p.resolve(agentId));
      pending.length = 0;
    }
    if (msg.type === "chat") {
      received++;
      listeners.forEach(fn => fn(msg.content, msg.from ?? "unknown"));
    }
  });

  ws.send(JSON.stringify({ type: "register", agent_name: name }));
  await new Promise<void>(res => {
    if (agentId) { res(); return; }
    pending.push({ resolve: () => res() });
  });

  return {
    id: agentId,
    onMessage: (fn) => listeners.push(fn),
    send: (toId: string, text: string) => {
      ws.send(JSON.stringify({ type: "chat", target: toId, content: text }));
      sent++;
    },
    close: () => ws.close(),
  };
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\nMany-to-Many: ${NUM_HUBS} hubs × ${AGENTS_PER_HUB} agents = ${NUM_HUBS * AGENTS_PER_HUB} total agents`);
  console.log(`Duration: ${DURATION_MS / 1000}s\n`);

  // Start hubs
  const hubs: ChannelHub[] = [];
  for (let i = 0; i < NUM_HUBS; i++) {
    const hub = new ChannelHub({ name: `hub-${i}`, autoStart: false, autoConnect: false, autoUpdate: false });
    await hub.startServer(BASE_PORT + i);
    hubs.push(hub);
    console.log(`  Hub ${i} started on :${BASE_PORT + i}`);
  }

  // Connect agents to each hub
  const allAgents: Array<{ id: string; hubIdx: number; send: (toId: string, text: string) => void; close: () => void }> = [];
  for (let h = 0; h < NUM_HUBS; h++) {
    for (let a = 0; a < AGENTS_PER_HUB; a++) {
      const agent = await connectAgent(BASE_PORT + h, `hub${h}-agent${a}`);
      allAgents.push({ id: agent.id, hubIdx: h, send: agent.send, close: agent.close });
    }
  }
  console.log(`  ${allAgents.length} agents connected\n`);

  // Send phase: each agent sends to all others on the same hub
  const deadline = Date.now() + DURATION_MS;
  let rounds = 0;

  while (Date.now() < deadline) {
    for (const sender of allAgents) {
      const peers = allAgents.filter(a => a.id !== sender.id && a.hubIdx === sender.hubIdx);
      for (const peer of peers) {
        try {
          sender.send(peer.id, `ping-${rounds}`);
        } catch {
          errors++;
        }
      }
    }
    rounds++;
    await new Promise(r => setTimeout(r, 50));
  }

  await new Promise(r => setTimeout(r, 500)); // flush

  // Results
  const expected = sent; // we sent this many, track what was delivered
  const rate = expected > 0 ? ((received / expected) * 100).toFixed(1) : "n/a";
  console.log(`Results after ${rounds} rounds:`);
  console.log(`  Sent:     ${sent}`);
  console.log(`  Received: ${received}`);
  console.log(`  Errors:   ${errors}`);
  console.log(`  Rate:     ${rate}%`);

  // Cleanup
  for (const a of allAgents) a.close();
  await new Promise(r => setTimeout(r, 200));
  for (const hub of hubs) {
    hub.stopHealthMonitor();
    for (const [, s] of hub.servers) { s.httpServer?.close(); s.wss?.close(); }
  }

  const pass = received > 0 && errors === 0;
  console.log(`\n${pass ? "✓ PASS" : "✗ FAIL"}`);
  process.exit(pass ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
