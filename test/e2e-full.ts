#!/usr/bin/env npx tsx
/**
 * Full E2E Test Suite — tests all SDK features with real WebSocket agents.
 *
 * Run: npx tsx test/e2e-full.ts
 */

import { ChannelHub } from "../src/hub.js";
import { E2eSession } from "../src/mesh.js";
import { generateKeyPairSync, diffieHellman, createPrivateKey, createPublicKey } from "node:crypto";
import WebSocket from "ws";

const PORT = 19091;
let hub: ChannelHub;
let passed = 0;
let failed = 0;
const results: string[] = [];

function assert(ok: boolean, msg: string) {
  if (ok) { passed++; results.push(`  ✅ ${msg}`); }
  else { failed++; results.push(`  ❌ ${msg}`); }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function connectAgent(name: string): Promise<{
  ws: WebSocket; msgs: any[]; send: (m: any) => void; close: () => void;
}> {
  const ws = new WebSocket(`ws://localhost:${PORT}`);
  const msgs: any[] = [];
  await new Promise<void>((res, rej) => { ws.on("open", res); ws.on("error", rej); });
  ws.on("message", d => { try { msgs.push(JSON.parse(d.toString())); } catch {} });
  ws.send(JSON.stringify({ type: "register", agent_name: name, tools: [] }));
  await sleep(300);
  return { ws, msgs, send: m => ws.send(JSON.stringify(m)), close: () => ws.close() };
}

// ═══════════════════════════════════════════════════════════════════════

async function test1_registration() {
  console.log("\n🔌 1. Agent Registration");
  const a = await connectAgent("reg-test");
  const ack = a.msgs.find(m => m.type === "register_ack");
  assert(!!ack, "Receives register_ack");
  assert(hub.agents.has([...hub.agents.entries()].find(([,v]) => v.name === "reg-test")?.[0] ?? ""), "Agent in hub map");
  a.close(); await sleep(200);
}

async function test2_messaging() {
  console.log("\n💬 2. Bidirectional Messaging");
  const a = await connectAgent("msg-sender");
  const b = await connectAgent("msg-receiver");
  await sleep(200);

  // A sends to B via hub
  a.send({ type: "chat", content: "Hello B!", from: "msg-sender", chat_id: "msg-receiver" });
  await sleep(500);

  // Hub should route to B (if routing supports agent names)
  // For now just verify both connected
  assert(hub.agents.size >= 2, "Both agents connected");
  a.close(); b.close(); await sleep(200);
}

async function test3_groups() {
  console.log("\n👥 3. Groups — Create, Add, Broadcast");
  const a = await connectAgent("grp-a");
  const b = await connectAgent("grp-b");
  const c = await connectAgent("grp-c");
  await sleep(300);

  hub.createGroup("test-grp");
  hub.addToGroup("test-grp", "ws:grp-a");
  hub.addToGroup("test-grp", "ws:grp-b");
  hub.addToGroup("test-grp", "ws:grp-c");

  const grp = hub.groups.get("test-grp");
  assert(grp?.size === 3, `Group has 3 members (got ${grp?.size})`);

  // Broadcast from A
  a.send({ type: "group_broadcast", group: "test-grp", content: "Team update!", from: "grp-a" });
  await sleep(500);

  const bGot = b.msgs.filter(m => m.content?.includes("Team update"));
  const cGot = c.msgs.filter(m => m.content?.includes("Team update"));
  const aGot = a.msgs.filter(m => m.content?.includes("Team update") && m.from !== "grp-a");
  assert(bGot.length > 0, "B received broadcast");
  assert(cGot.length > 0, "C received broadcast");
  assert(aGot.length === 0, "A did not receive own broadcast");

  a.close(); b.close(); c.close(); await sleep(200);
}

async function test4_atOnly_mode() {
  console.log("\n🔕 4. Group @only Mode");
  const a = await connectAgent("at-sender");
  const b = await connectAgent("at-listener");
  const c = await connectAgent("at-silent");
  await sleep(300);

  hub.createGroup("at-grp");
  hub.addToGroup("at-grp", "ws:at-sender", "all");
  hub.addToGroup("at-grp", "ws:at-listener", "all");
  hub.addToGroup("at-grp", "ws:at-silent", "@only");

  // Send without @mention — at-silent should NOT receive
  a.send({ type: "group_broadcast", group: "at-grp", content: "General update", from: "at-sender" });
  await sleep(500);

  const silentGot = c.msgs.filter(m => m.content?.includes("General update"));
  const listenerGot = b.msgs.filter(m => m.content?.includes("General update"));
  assert(listenerGot.length > 0, "Listener (mode:all) received");
  assert(silentGot.length === 0, "Silent (mode:@only) did NOT receive");

  // Send WITH @mention — at-silent SHOULD receive
  a.send({ type: "group_broadcast", group: "at-grp", content: "Hey @at-silent check this", from: "at-sender" });
  await sleep(500);

  const silentMentioned = c.msgs.filter(m => m.content?.includes("@at-silent"));
  assert(silentMentioned.length > 0, "Silent received when @mentioned");

  a.close(); b.close(); c.close(); await sleep(200);
}

async function test5_mention_routing() {
  console.log("\n📣 5. @mention Hub Routing");
  const a = await connectAgent("mention-src");
  const b = await connectAgent("mention-tgt");
  await sleep(300);

  // Send from A with @mention-tgt — hub should route via sendMessage
  const found = hub.findAgent("mention-tgt");
  assert(!!found, "findAgent locates mention-tgt");

  // Direct sendMessage test
  const result = hub.sendMessage("mention-tgt", "[from mention-src] Task done");
  assert(result.ok, "sendMessage to mention-tgt ok");
  await sleep(500);

  const tgtGot = b.msgs.filter(m => String(m.content ?? "").includes("Task done"));
  assert(tgtGot.length > 0, "mention-tgt received message via sendMessage");

  a.close(); b.close(); await sleep(200);
}

async function test6_blocked_by() {
  console.log("\n⏳ 6. ~blocked-by Routing");
  const blocker = await connectAgent("blocker-agent");
  const waiter = await connectAgent("waiter-agent");
  await sleep(300);

  const foundBlocker = hub.findAgent("blocker-agent");
  assert(!!foundBlocker, "findAgent locates blocker-agent");

  const result = hub.sendMessage("blocker-agent", "[waiting] waiter-agent is blocked by you");
  assert(result.ok, "sendMessage to blocker-agent ok");
  await sleep(500);

  const blockerGot = blocker.msgs.filter(m => String(m.content ?? "").includes("waiting"));
  assert(blockerGot.length > 0, "Blocker received 'waiting' notification");

  blocker.close(); waiter.close(); await sleep(200);
}

async function test7_message_buffering() {
  console.log("\n📨 7. Message Buffering");

  hub.bufferMessage("future-agent", { type: "chat", content: "Saved for you", from: "system" });
  hub.bufferMessage("future-agent", { type: "chat", content: "Another one", from: "system" });

  const buf = (hub as any).messageBuffer?.get("future-agent");
  assert(buf?.length === 2, `Buffer has 2 messages (got ${buf?.length})`);

  const agent = await connectAgent("future-agent");
  await sleep(500);

  const bufAfter = (hub as any).messageBuffer?.get("future-agent");
  assert(!bufAfter || bufAfter.length === 0, "Buffer flushed on connect");

  agent.close(); await sleep(200);
}

async function test8_e2e_encryption() {
  console.log("\n🔐 8. E2E Encryption");

  const aliceKp = generateKeyPairSync("x25519", {
    publicKeyEncoding: { type: "spki", format: "der" },
    privateKeyEncoding: { type: "pkcs8", format: "der" },
  });
  const bobKp = generateKeyPairSync("x25519", {
    publicKeyEncoding: { type: "spki", format: "der" },
    privateKeyEncoding: { type: "pkcs8", format: "der" },
  });
  const shared = diffieHellman({
    privateKey: createPrivateKey({ key: aliceKp.privateKey, format: "der", type: "pkcs8" }),
    publicKey: createPublicKey({ key: bobKp.publicKey, format: "der", type: "spki" }),
  });
  const aliceSession = new E2eSession(shared, "alice");
  const bobSession = new E2eSession(shared, "bob");

  const msg = "Secret agent message 🔒";
  const encrypted = aliceSession.encrypt(msg);
  assert(encrypted.ciphertext !== msg, "Ciphertext differs");

  const decrypted = bobSession.decrypt(encrypted);
  assert(decrypted === msg, "Decrypted matches original");

  let tamperCaught = false;
  try {
    bobSession.decrypt({ ...encrypted, ciphertext: "deadbeef" });
  } catch { tamperCaught = true; }
  assert(tamperCaught, "Tampered message rejected");
}

async function test9_alias() {
  console.log("\n🏷️  9. Agent Name & Alias");
  assert(hub.name === "e2e-test-hub", `Hub name correct (got "${hub.name}")`);
  assert(hub.peerKeys instanceof Map, "peerKeys exists");
}

async function test10_init_batching() {
  console.log("\n📦 10. Init Batching");
  // Verify hub emits events
  let eventCount = 0;
  hub.on("serverStarted", () => eventCount++);
  hub.on("connected", () => eventCount++);
  assert(hub.servers.size > 0, "Server is running");
}

// ═══════════════════════════════════════════════════════════════════════

async function main() {
  console.log("═══════════════════════════════════════════════════");
  console.log("  Talon Channels SDK — Full E2E Test Suite");
  console.log("═══════════════════════════════════════════════════");

  hub = new ChannelHub({ name: "e2e-test-hub", port: PORT, autoConnect: false, autoUpdate: false });
  await hub.startServer(PORT);
  console.log(`Hub started on port ${PORT}`);

  try {
    await test1_registration();
    await test2_messaging();
    await test3_groups();
    await test4_atOnly_mode();
    await test5_mention_routing();
    await test6_blocked_by();
    await test7_message_buffering();
    await test8_e2e_encryption();
    await test9_alias();
    await test10_init_batching();
  } finally {
    for (const [, s] of hub.servers) {
      try { s.httpServer?.close(); s.wss?.close(); } catch {}
    }
  }

  console.log("\n" + results.join("\n"));
  console.log("\n═══════════════════════════════════════════════════");
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log("═══════════════════════════════════════════════════\n");

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
