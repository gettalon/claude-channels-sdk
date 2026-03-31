/**
 * Group broadcast scenario.
 *
 * Creates a hub with N agents in a group. One sender broadcasts messages
 * to the group and verifies all members receive them.
 *
 * Usage:
 *   npx tsx test/scenarios/group-broadcast.ts [--members 20] [--messages 50]
 */
import { ChannelHub } from "../../dist/index.js";
import WebSocket from "ws";

const args = process.argv.slice(2);
const getArg = (flag: string, def: number) => {
  const i = args.indexOf(flag);
  return i >= 0 ? parseInt(args[i + 1]) : def;
};
const NUM_MEMBERS = getArg("--members", 20);
const NUM_MESSAGES = getArg("--messages", 50);
const BASE_PORT = 20300;

async function connectAgent(port: number, name: string): Promise<{
  id: string;
  received: string[];
  close: () => void;
}> {
  const ws = new WebSocket(`ws://localhost:${port}`);
  await new Promise<void>((res, rej) => { ws.on("open", res); ws.on("error", rej); });
  let agentId = "";
  const received: string[] = [];

  ws.on("message", (raw: Buffer) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === "register_ack" && msg.status === "ok") agentId = msg.agent_id;
    if (msg.type === "chat" || msg.type === "group_broadcast") received.push(msg.content);
  });

  ws.send(JSON.stringify({ type: "register", agent_name: name }));
  await new Promise<void>(res => {
    const t = setInterval(() => { if (agentId) { clearInterval(t); res(); } }, 10);
    setTimeout(() => { clearInterval(t); res(); }, 2000);
  });
  return { id: agentId, received, close: () => ws.close() };
}

async function main() {
  console.log(`\nGroup Broadcast: 1 sender → ${NUM_MEMBERS} members, ${NUM_MESSAGES} messages\n`);

  const hub = new ChannelHub({ name: "broadcast-hub", autoStart: false, autoConnect: false, autoUpdate: false });
  await hub.startServer(BASE_PORT);

  // Connect all members
  const members: Array<{ id: string; received: string[]; close: () => void }> = [];
  for (let i = 0; i < NUM_MEMBERS; i++) {
    const m = await connectAgent(BASE_PORT, `member-${i}`);
    members.push(m);
  }

  // Connect sender
  const sender = await connectAgent(BASE_PORT, "sender");

  // Create group and add all members
  hub.createGroup("broadcast");
  for (const m of members) {
    hub.addToGroup("broadcast", m.id);
  }
  console.log(`  Group "broadcast" created with ${NUM_MEMBERS} members`);

  // Send messages to group
  const startTime = Date.now();
  for (let i = 0; i < NUM_MESSAGES; i++) {
    const r = (hub as any).broadcastToGroup("broadcast", `msg-${i}`, "sender");
    if (r && !r.ok) console.warn(`  Send ${i} failed: ${r.error}`);
    await new Promise(r => setTimeout(r, 10));
  }
  await new Promise(r => setTimeout(r, 500)); // flush

  const elapsed = Date.now() - startTime;
  const expectedTotal = NUM_MEMBERS * NUM_MESSAGES;
  const actualTotal = members.reduce((sum, m) => sum + m.received.length, 0);
  const rate = ((actualTotal / expectedTotal) * 100).toFixed(1);

  console.log(`\nResults:`);
  console.log(`  Messages sent:    ${NUM_MESSAGES}`);
  console.log(`  Expected total:   ${expectedTotal} (${NUM_MEMBERS} members × ${NUM_MESSAGES})`);
  console.log(`  Received total:   ${actualTotal}`);
  console.log(`  Delivery rate:    ${rate}%`);
  console.log(`  Time:             ${elapsed}ms`);

  // Check all members got all messages
  let allReceived = true;
  for (let i = 0; i < members.length; i++) {
    if (members[i].received.length !== NUM_MESSAGES) {
      console.log(`  member-${i}: got ${members[i].received.length}/${NUM_MESSAGES}`);
      allReceived = false;
    }
  }

  // Cleanup
  for (const m of members) m.close();
  sender.close();
  await new Promise(r => setTimeout(r, 200));
  hub.stopHealthMonitor();
  for (const [, s] of hub.servers) { s.httpServer?.close(); s.wss?.close(); }

  const pass = allReceived && actualTotal === expectedTotal;
  console.log(`\n${pass ? "✓ PASS" : "✗ FAIL"}`);
  process.exit(pass ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
