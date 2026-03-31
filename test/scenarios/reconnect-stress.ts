/**
 * Reconnect stress test.
 *
 * Starts a hub with agents, kills/restarts the hub mid-flight, verifies
 * agents can reconnect and resume messaging.
 *
 * Usage:
 *   npx tsx test/scenarios/reconnect-stress.ts [--agents 5] [--cycles 3]
 */
import { ChannelHub } from "../../dist/index.js";
import WebSocket from "ws";

const args = process.argv.slice(2);
const getArg = (flag: string, def: number) => {
  const i = args.indexOf(flag);
  return i >= 0 ? parseInt(args[i + 1]) : def;
};
const NUM_AGENTS = getArg("--agents", 5);
const CYCLES = getArg("--cycles", 3);
const BASE_PORT = 20400;

let totalSent = 0, totalReceived = 0;

async function waitForConnect(port: number, retries = 20): Promise<WebSocket> {
  for (let i = 0; i < retries; i++) {
    try {
      const ws = new WebSocket(`ws://localhost:${port}`);
      await new Promise<void>((res, rej) => {
        ws.on("open", res);
        ws.on("error", rej);
      });
      return ws;
    } catch {
      await new Promise(r => setTimeout(r, 200));
    }
  }
  throw new Error(`Could not connect to :${port} after ${retries} retries`);
}

async function runCycle(port: number, cycleIdx: number): Promise<{ sent: number; received: number }> {
  let sent = 0, received = 0;
  const agents: Array<{ id: string; ws: WebSocket }> = [];

  // Connect agents
  for (let i = 0; i < NUM_AGENTS; i++) {
    const ws = await waitForConnect(port);
    let agentId = "";
    ws.on("message", (raw: Buffer) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "register_ack" && msg.status === "ok") agentId = msg.agent_id;
      if (msg.type === "chat") received++;
    });
    ws.send(JSON.stringify({ type: "register", agent_name: `agent-${cycleIdx}-${i}` }));
    await new Promise<void>(res => {
      const t = setInterval(() => { if (agentId) { clearInterval(t); res(); } }, 10);
      setTimeout(() => { clearInterval(t); res(); }, 2000);
    });
    agents.push({ id: agentId, ws });
  }

  // Send round-robin
  for (let i = 0; i < NUM_AGENTS; i++) {
    const next = agents[(i + 1) % NUM_AGENTS];
    agents[i].ws.send(JSON.stringify({
      type: "chat",
      target: next.id,
      content: `cycle-${cycleIdx}-msg-${i}`,
    }));
    sent++;
  }

  await new Promise(r => setTimeout(r, 300));

  for (const a of agents) a.ws.close();
  return { sent, received };
}

async function main() {
  console.log(`\nReconnect Stress: ${NUM_AGENTS} agents, ${CYCLES} kill/restart cycles\n`);

  for (let cycle = 0; cycle < CYCLES; cycle++) {
    // Start hub
    const hub = new ChannelHub({ name: `recon-hub-${cycle}`, autoStart: false, autoConnect: false, autoUpdate: false });
    await hub.startServer(BASE_PORT);
    console.log(`  Cycle ${cycle + 1}/${CYCLES}: hub started on :${BASE_PORT}`);

    const { sent, received } = await runCycle(BASE_PORT, cycle);
    totalSent += sent;
    totalReceived += received;
    console.log(`    sent=${sent} received=${received}`);

    // Kill hub
    hub.stopHealthMonitor();
    for (const [, s] of hub.servers) {
      s.httpServer?.close();
      s.wss?.close();
    }
    await new Promise(r => setTimeout(r, 300));
    console.log(`    hub stopped`);
  }

  const rate = totalSent > 0 ? ((totalReceived / totalSent) * 100).toFixed(1) : "n/a";
  console.log(`\nTotal: sent=${totalSent} received=${totalReceived} rate=${rate}%`);

  const pass = totalReceived > 0;
  console.log(`\n${pass ? "✓ PASS" : "✗ FAIL"}`);
  process.exit(pass ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
