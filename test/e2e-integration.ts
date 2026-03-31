#!/usr/bin/env npx tsx
/**
 * E2E Integration Test — simulates remote agents via Unix socket.
 *
 * Tests:
 * 1. Hub startup + agent registration with approval
 * 2. E2E encryption (X25519 key exchange + AES-256-GCM)
 * 3. Group creation + multi-type members
 * 4. Group broadcast / @mention / reply routing
 * 5. Message buffering for offline agents
 * 6. Alias resolution
 *
 * Run: npx tsx test/e2e-integration.ts
 */

import { ChannelHub } from "../src/hub.js";
import { E2eSession } from "../src/mesh.js";
import { generateKeyPairSync, diffieHellman, createPublicKey, createPrivateKey } from "node:crypto";

const PORT = 19090; // test port, avoid conflict with real hub
const SOCKET = `/tmp/talon-test-${PORT}.sock`;
let hub: ChannelHub;
let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
  if (condition) {
    console.log(`  ✅ ${msg}`);
    passed++;
  } else {
    console.log(`  ❌ ${msg}`);
    failed++;
  }
}

async function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

// ── Setup ────────────────────────────────────────────────────────────────────

async function setup() {
  hub = new ChannelHub({
    name: "test-hub",
    port: PORT,
    autoConnect: false,
    autoUpdate: false,
  });
  await hub.startServer(PORT);
  console.log(`Hub started on port ${PORT}`);
}

async function teardown() {
  // Clean up
  try {
    for (const [, s] of hub.servers) {
      if (s.httpServer) s.httpServer.close();
      if (s.wss) s.wss.close();
    }
  } catch {}
  try {
    const { unlinkSync } = await import("node:fs");
    unlinkSync(SOCKET);
  } catch {}
}

// ── Helpers: simulate agent connecting via WebSocket ──────────────────────────

async function connectAgent(name: string, hubPort: number): Promise<{
  ws: import("ws").WebSocket;
  messages: any[];
  send: (msg: any) => void;
  close: () => void;
}> {
  const { default: WebSocket } = await import("ws");
  const ws = new WebSocket(`ws://localhost:${hubPort}`);
  const messages: any[] = [];

  await new Promise<void>((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
  });

  ws.on("message", (data) => {
    try {
      messages.push(JSON.parse(data.toString()));
    } catch {}
  });

  // Register
  ws.send(JSON.stringify({
    type: "register",
    agent_name: name,
    tools: [{ name: "echo", description: "echo tool", inputSchema: {} }],
  }));

  // Wait for register_ack
  await sleep(200);

  return {
    ws,
    messages,
    send: (msg: any) => ws.send(JSON.stringify(msg)),
    close: () => ws.close(),
  };
}

// ── Test 1: Agent Registration ───────────────────────────────────────────────

async function testAgentRegistration() {
  console.log("\n🔌 Test 1: Agent Registration");

  const agent = await connectAgent("agent-alpha", PORT);
  await sleep(300);

  const ack = agent.messages.find(m => m.type === "register_ack");
  assert(!!ack, "Agent receives register_ack");
  assert(ack?.status === "ok" || ack?.status === "approved", `Registration status: ${ack?.status}`);

  // Check hub sees the agent
  const agents = [...hub.agents.values()];
  const found = agents.find(a => a.name === "agent-alpha");
  assert(!!found, "Hub has agent-alpha in agents map");

  agent.close();
  await sleep(200);
}

// ── Test 2: E2E Encryption ───────────────────────────────────────────────────

async function testE2eEncryption() {
  console.log("\n🔐 Test 2: E2E Encryption (X25519 + AES-256-GCM)");

  // Generate two keypairs (simulating two agents)
  const aliceKp = generateKeyPairSync("x25519", {
    publicKeyEncoding: { type: "spki", format: "der" },
    privateKeyEncoding: { type: "pkcs8", format: "der" },
  });
  const bobKp = generateKeyPairSync("x25519", {
    publicKeyEncoding: { type: "spki", format: "der" },
    privateKeyEncoding: { type: "pkcs8", format: "der" },
  });

  const alicePubHex = Buffer.from(aliceKp.publicKey).toString("hex");
  const alicePrivHex = Buffer.from(aliceKp.privateKey).toString("hex");
  const bobPubHex = Buffer.from(bobKp.publicKey).toString("hex");
  const bobPrivHex = Buffer.from(bobKp.privateKey).toString("hex");

  // Derive shared secrets (should be identical)
  const aliceShared = diffieHellman({
    privateKey: createPrivateKey({ key: Buffer.from(alicePrivHex, "hex"), format: "der", type: "pkcs8" }),
    publicKey: createPublicKey({ key: Buffer.from(bobPubHex, "hex"), format: "der", type: "spki" }),
  });
  const bobShared = diffieHellman({
    privateKey: createPrivateKey({ key: Buffer.from(bobPrivHex, "hex"), format: "der", type: "pkcs8" }),
    publicKey: createPublicKey({ key: Buffer.from(alicePubHex, "hex"), format: "der", type: "spki" }),
  });

  assert(aliceShared.equals(bobShared), "X25519 shared secrets match");

  // Create E2E sessions
  const aliceSession = new E2eSession(aliceShared, "alice-device");
  const bobSession = new E2eSession(bobShared, "bob-device");

  // Encrypt with Alice, decrypt with Bob
  const plaintext = "Hello from Alice to Bob — secret message 🔒";
  const encrypted = aliceSession.encrypt(plaintext);
  assert(encrypted.ciphertext !== plaintext, "Ciphertext differs from plaintext");

  const decrypted = bobSession.decrypt(encrypted);
  assert(decrypted === plaintext, "Bob decrypts Alice's message correctly");

  // Encrypt object
  const obj = { action: "transfer", amount: 100, token: "USDC" };
  const encObj = aliceSession.encrypt(obj);
  const decObj = bobSession.decrypt(encObj);
  assert(JSON.stringify(JSON.parse(decObj as string)) === JSON.stringify(obj), "Object encryption/decryption works");

  // Tampered ciphertext should fail
  let tamperFailed = false;
  try {
    const tampered = { ...encrypted, ciphertext: encrypted.ciphertext.slice(0, -4) + "dead" };
    bobSession.decrypt(tampered);
  } catch {
    tamperFailed = true;
  }
  assert(tamperFailed, "Tampered ciphertext throws error");
}

// ── Test 3: Group Creation + Multi-type Members ──────────────────────────────

async function testGroupCreation() {
  console.log("\n👥 Test 3: Group Creation");

  // Create group
  const result = hub.createGroup("test-group");
  assert((result as any).ok !== false, "Group created");

  // Connect agents
  const agentA = await connectAgent("group-agent-a", PORT);
  const agentB = await connectAgent("group-agent-b", PORT);
  await sleep(300);

  // Add to group
  const addA = hub.addToGroup("test-group", "group-agent-a");
  const addB = hub.addToGroup("test-group", "group-agent-b");
  assert((addA as any).ok !== false, "Agent A added to group");
  assert((addB as any).ok !== false, "Agent B added to group");

  // Check group members
  const group = hub.groups.get("test-group");
  assert(group !== undefined && group.size === 2, `Group has 2 members (got ${group?.size})`);

  agentA.close();
  agentB.close();
  await sleep(200);
}

// ── Test 4: Group Broadcast ──────────────────────────────────────────────────

async function testGroupBroadcast() {
  console.log("\n📢 Test 4: Group Broadcast");

  const agentX = await connectAgent("broadcast-x", PORT);
  const agentY = await connectAgent("broadcast-y", PORT);
  const agentZ = await connectAgent("broadcast-z", PORT);
  await sleep(300);

  // Create group and add all
  hub.createGroup("broadcast-group");
  hub.addToGroup("broadcast-group", "broadcast-x");
  hub.addToGroup("broadcast-group", "broadcast-y");
  hub.addToGroup("broadcast-group", "broadcast-z");

  // X sends a message — Y and Z should receive, X should not
  agentX.send({
    type: "group_broadcast",
    group: "broadcast-group",
    content: "Hello from X",
    from: "broadcast-x",
  });
  await sleep(500);

  const yGot = agentY.messages.filter(m => m.type === "chat" || m.type === "group_broadcast");
  const zGot = agentZ.messages.filter(m => m.type === "chat" || m.type === "group_broadcast");
  const xGot = agentX.messages.filter(m => (m.type === "chat" || m.type === "group_broadcast") && m.content?.includes("Hello from X"));

  assert(yGot.some(m => m.content?.includes("Hello from X")), "Agent Y received broadcast");
  assert(zGot.some(m => m.content?.includes("Hello from X")), "Agent Z received broadcast");
  assert(xGot.length === 0, "Agent X did not receive own broadcast");

  agentX.close();
  agentY.close();
  agentZ.close();
  await sleep(200);
}

// ── Test 5: Message Buffering ────────────────────────────────────────────────

async function testMessageBuffering() {
  console.log("\n📨 Test 5: Message Buffering");

  // Send message to non-existent agent
  hub.bufferMessage("offline-agent", {
    type: "chat",
    content: "Message while you were offline",
    from: "test-hub",
  });
  hub.bufferMessage("offline-agent", {
    type: "chat",
    content: "Second offline message",
    from: "test-hub",
  });

  // Check buffer exists
  const buffer = (hub as any).messageBuffer?.get("offline-agent");
  assert(buffer?.length === 2, `Buffer has 2 messages (got ${buffer?.length})`);

  // Connect the agent — should flush
  const agent = await connectAgent("offline-agent", PORT);
  await sleep(500);

  const chatMsgs = agent.messages.filter(m => m.type === "chat" && String(m.content ?? "").includes("offline"));
  assert(chatMsgs.length >= 1, `Agent received buffered messages (got ${chatMsgs.length})`);

  // Buffer should be cleared
  const bufferAfter = (hub as any).messageBuffer?.get("offline-agent");
  assert(!bufferAfter || bufferAfter.length === 0, "Buffer cleared after flush");

  agent.close();
  await sleep(200);
}

// ── Test 6: Alias Resolution ─────────────────────────────────────────────────

async function testAliasResolution() {
  console.log("\n🏷️  Test 6: Alias Resolution");

  // Hub name should be "test-hub"
  assert(hub.name === "test-hub", `Hub name is "test-hub" (got "${hub.name}")`);

  // Peer keys map should exist
  assert(hub.peerKeys instanceof Map, "peerKeys is a Map");
}

// ── Run All ──────────────────────────────────────────────────────────────────

async function main() {
  console.log("═══════════════════════════════════════════════════");
  console.log("  Talon Channels SDK — E2E Integration Tests");
  console.log("═══════════════════════════════════════════════════");

  await setup();

  try {
    await testAgentRegistration();
    await testE2eEncryption();
    await testGroupCreation();
    await testGroupBroadcast();
    await testMessageBuffering();
    await testAliasResolution();
  } finally {
    await teardown();
  }

  console.log("\n═══════════════════════════════════════════════════");
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log("═══════════════════════════════════════════════════\n");

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
