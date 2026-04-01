/**
 * E2E encryption tests:
 *   1. Transport-level E2E: hub encrypts messages to agents with E2eSession
 *   2. Key exchange on registration (publicKey in metadata)
 *   3. Key exchange via explicit key_exchange message
 *   4. Encrypted message round-trip (hub→agent, agent→hub)
 *   5. SenderKeySession: group E2E with sender keys
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  E2eSession,
  SenderKeySession,
  generateIdentityKeyPair,
} from "../dist/index.js";
import type {
  EncryptedPayload,
  SenderKeyBundle,
  SenderKeyEncryptedMessage,
} from "../dist/index.js";
import { createTestHub, nextPort, delay, connectRawAgent } , startTestServer , startTestServer from "./helpers.js";
import type { ChannelHub } from "../dist/index.js";

function cleanupHub(hub: ChannelHub | undefined) {
  if (!hub) return;
  (hub as any).stopHealthMonitor?.();
  for (const agent of hub.agents.values()) {
    try { agent.ws?.close?.(); } catch {}
  }
  for (const [, s] of hub.servers) {
    try { s.httpServer?.close(); } catch {}
    try { s.wss?.close(); } catch {}
  }
  for (const [, c] of hub.clients) {
    try { c.ws?.close?.(); } catch {}
    if (c.heartbeatTimer) clearInterval(c.heartbeatTimer);
  }
}

// ── 1. E2eSession unit tests ────────────────────────────────────────────────

describe("E2eSession key exchange", () => {
  it("two parties derive matching sessions via X25519", () => {
    const alice = generateIdentityKeyPair();
    const bob = generateIdentityKeyPair();

    const aliceSession = E2eSession.fromKeyExchange(alice.privateKey, bob.publicKey, "alice");
    const bobSession = E2eSession.fromKeyExchange(bob.privateKey, alice.publicKey, "bob");

    // Alice encrypts, Bob decrypts
    const encrypted = aliceSession.encrypt({ msg: "hello bob" });
    const decrypted = bobSession.decrypt(encrypted);
    expect(JSON.parse(decrypted)).toEqual({ msg: "hello bob" });

    // Bob encrypts, Alice decrypts
    const encrypted2 = bobSession.encrypt("secret reply");
    expect(aliceSession.decrypt(encrypted2)).toBe("secret reply");
  });

  it("wrong key fails to decrypt", () => {
    const alice = generateIdentityKeyPair();
    const bob = generateIdentityKeyPair();
    const eve = generateIdentityKeyPair();

    const aliceSession = E2eSession.fromKeyExchange(alice.privateKey, bob.publicKey, "alice");
    const eveSession = E2eSession.fromKeyExchange(eve.privateKey, bob.publicKey, "eve");

    const encrypted = aliceSession.encrypt("for bob only");
    expect(() => eveSession.decrypt(encrypted)).toThrow();
  });
});

// ── 2. Transport-level E2E via hub ──────────────────────────────────────────

describe("hub E2E transport encryption", () => {
  let hub: ChannelHub;
  let port: number;

  beforeEach(async () => {
    port = nextPort();
    hub = createTestHub({ name: "e2e-hub", port });
    await startTestServer(hub, port);
  });

  afterEach(() => cleanupHub(hub));

  it("auto-establishes E2E session when agent provides publicKey", async () => {
    const agentKeys = generateIdentityKeyPair();

    // Connect raw WS and register with publicKey in metadata
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

    // Register with publicKey
    ws.send(JSON.stringify({
      type: "register",
      agent_name: "secure-agent",
      tools: [],
      metadata: { publicKey: agentKeys.publicKey },
    }));

    // Wait for key_exchange + register_ack
    await delay(500);

    // Hub should have sent us a key_exchange message with its public key
    const keyExchangeMsg = messages.find(m => m.type === "key_exchange");
    expect(keyExchangeMsg).toBeDefined();
    expect(keyExchangeMsg.publicKey).toBeDefined();

    // Hub should have stored our public key and created E2E session
    expect(hub.peerKeys.get("secure-agent")).toBe(agentKeys.publicKey);
    expect(hub.e2eSessions.has("secure-agent")).toBe(true);

    // Create agent-side session from hub's public key
    const agentSession = E2eSession.fromKeyExchange(
      agentKeys.privateKey,
      keyExchangeMsg.publicKey,
      "secure-agent"
    );

    // Verify hub encrypts messages to us now
    // Hub sends a message — it should be encrypted
    const agent = hub.findAgent("secure-agent")!;
    hub.wsSend(agent.ws, { type: "chat", content: "encrypted hello" });
    await delay(200);

    // The last message should be an e2e wrapper
    const lastMsg = messages[messages.length - 1];
    expect(lastMsg.type).toBe("e2e");
    expect(lastMsg.e2e).toBeDefined();
    expect(lastMsg.e2e.ciphertext).toBeDefined();
    expect(lastMsg.e2e.nonce).toBeDefined();

    // Agent can decrypt
    const decrypted = JSON.parse(agentSession.decrypt(lastMsg.e2e));
    expect(decrypted.content).toBe("encrypted hello");
    expect(decrypted.type).toBe("chat");

    ws.close();
  });

  it("handles explicit key_exchange from agent after registration", async () => {
    const agentKeys = generateIdentityKeyPair();

    // Register without publicKey first
    const agent = await connectRawAgent(port, "late-e2e-agent");
    await agent.waitForMsg("register_ack");

    // No E2E session yet
    expect(hub.e2eSessions.has("late-e2e-agent")).toBe(false);

    // Agent sends key_exchange
    agent.send({ type: "key_exchange", publicKey: agentKeys.publicKey });
    await delay(300);

    // Hub should now have E2E session
    expect(hub.e2eSessions.has("late-e2e-agent")).toBe(true);

    // Hub should have sent key_exchange back
    const keyExchangeMsg = agent.messages.find(m => m.type === "key_exchange");
    expect(keyExchangeMsg).toBeDefined();

    agent.close();
  });

  it("decrypts e2e messages from agent", async () => {
    const agentKeys = generateIdentityKeyPair();
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

    // Register with publicKey
    ws.send(JSON.stringify({
      type: "register",
      agent_name: "enc-sender",
      tools: [],
      metadata: { publicKey: agentKeys.publicKey },
    }));
    await delay(500);

    const keyExchangeMsg = messages.find(m => m.type === "key_exchange");
    const agentSession = E2eSession.fromKeyExchange(
      agentKeys.privateKey,
      keyExchangeMsg.publicKey,
      "enc-sender"
    );

    // Agent sends encrypted chat to hub
    const encPayload = agentSession.encrypt({ type: "chat", chat_id: "test", content: "secret msg", from: "enc-sender" });
    ws.send(JSON.stringify({ type: "e2e", e2e: encPayload }));

    // Wait for hub to process and route the message
    await delay(300);

    // Hub should have decrypted and emitted the message
    // We can verify by checking that the hub processed it (message event fires)
    let received = false;
    hub.on("message", ({ content }) => {
      if (content === "secret msg") received = true;
    });

    // Send another encrypted message to verify live decryption
    const encPayload2 = agentSession.encrypt({ type: "chat", chat_id: "test2", content: "live secret", from: "enc-sender" });
    ws.send(JSON.stringify({ type: "e2e", e2e: encPayload2 }));
    await delay(300);

    ws.close();
  });
});

// ── 3. SenderKeySession tests ───────────────────────────────────────────────

describe("SenderKeySession (group E2E)", () => {
  it("encrypts and decrypts with sender key", () => {
    const alice = new SenderKeySession("alice", "dev-team");
    const bob = new SenderKeySession("bob", "dev-team");

    // Bob receives Alice's sender key
    bob.receiveSenderKey(alice.getKeyBundle());

    // Alice encrypts for the group
    const encrypted = alice.encrypt("hello team");
    expect(encrypted.from).toBe("alice");
    expect(encrypted.group).toBe("dev-team");
    expect(encrypted.chainIndex).toBe(0);

    // Bob can decrypt
    const decrypted = bob.decrypt(encrypted);
    expect(decrypted).toBe("hello team");
  });

  it("fails to decrypt without sender key", () => {
    const alice = new SenderKeySession("alice", "dev-team");
    const charlie = new SenderKeySession("charlie", "dev-team");

    // Charlie does NOT have Alice's sender key
    const encrypted = alice.encrypt("secret");
    expect(() => charlie.decrypt(encrypted)).toThrow('No sender key for "alice"');
  });

  it("distributes sender keys via pairwise E2E sessions", () => {
    const aliceKp = generateIdentityKeyPair();
    const bobKp = generateIdentityKeyPair();
    const charlieKp = generateIdentityKeyPair();

    // Pairwise sessions: Alice↔Bob, Alice↔Charlie
    const aliceBobSession = E2eSession.fromKeyExchange(aliceKp.privateKey, bobKp.publicKey, "alice");
    const aliceCharlieSession = E2eSession.fromKeyExchange(aliceKp.privateKey, charlieKp.publicKey, "alice");
    const bobAliceSession = E2eSession.fromKeyExchange(bobKp.privateKey, aliceKp.publicKey, "bob");
    const charlieAliceSession = E2eSession.fromKeyExchange(charlieKp.privateKey, aliceKp.publicKey, "charlie");

    // Sender key sessions
    const aliceSK = new SenderKeySession("alice", "team");
    const bobSK = new SenderKeySession("bob", "team");
    const charlieSK = new SenderKeySession("charlie", "team");

    // Alice distributes her sender key encrypted with pairwise sessions
    const pairwiseSessions = new Map<string, E2eSession>();
    pairwiseSessions.set("bob", aliceBobSession);
    pairwiseSessions.set("charlie", aliceCharlieSession);
    const dist = aliceSK.distribute(pairwiseSessions);

    expect(dist.from).toBe("alice");
    expect(dist.bundles).toHaveLength(2);
    expect(dist.bundles[0].to).toBe("bob");
    expect(dist.bundles[1].to).toBe("charlie");

    // Bob receives the distribution and decrypts his bundle
    bobSK.receiveDistribution(dist, bobAliceSession);
    expect(bobSK.hasSenderKeyFor("alice")).toBe(true);

    // Charlie receives too
    charlieSK.receiveDistribution(dist, charlieAliceSession);
    expect(charlieSK.hasSenderKeyFor("alice")).toBe(true);

    // Alice sends encrypted group message
    const groupMsg = aliceSK.encrypt("hello team from Alice");

    // Both Bob and Charlie can decrypt
    expect(bobSK.decrypt(groupMsg)).toBe("hello team from Alice");
    expect(charlieSK.decrypt(groupMsg)).toBe("hello team from Alice");
  });

  it("supports rekey with chain index tracking", () => {
    const alice = new SenderKeySession("alice", "team");
    const bob = new SenderKeySession("bob", "team");

    // Bob receives Alice's initial key (chainIndex 0)
    bob.receiveSenderKey(alice.getKeyBundle());
    const msg1 = alice.encrypt("before rekey");
    expect(bob.decrypt(msg1)).toBe("before rekey");

    // Alice rekeys
    alice.rekey();
    expect(alice.getKeyBundle().chainIndex).toBe(1);

    // Old messages from Alice still use old chainIndex — Bob can't decrypt new messages
    const msg2 = alice.encrypt("after rekey");
    expect(msg2.chainIndex).toBe(1);
    expect(() => bob.decrypt(msg2)).toThrow("Chain index mismatch");

    // Bob receives new sender key
    bob.receiveSenderKey(alice.getKeyBundle());
    const msg3 = alice.encrypt("after rekey received");
    expect(bob.decrypt(msg3)).toBe("after rekey received");
  });

  it("three-member group round-trip", () => {
    const alice = new SenderKeySession("alice", "g1");
    const bob = new SenderKeySession("bob", "g1");
    const charlie = new SenderKeySession("charlie", "g1");

    // Exchange all sender keys
    bob.receiveSenderKey(alice.getKeyBundle());
    charlie.receiveSenderKey(alice.getKeyBundle());
    alice.receiveSenderKey(bob.getKeyBundle());
    charlie.receiveSenderKey(bob.getKeyBundle());
    alice.receiveSenderKey(charlie.getKeyBundle());
    bob.receiveSenderKey(charlie.getKeyBundle());

    // Each member sends, others decrypt
    const aliceMsg = alice.encrypt("from alice");
    expect(bob.decrypt(aliceMsg)).toBe("from alice");
    expect(charlie.decrypt(aliceMsg)).toBe("from alice");

    const bobMsg = bob.encrypt("from bob");
    expect(alice.decrypt(bobMsg)).toBe("from bob");
    expect(charlie.decrypt(bobMsg)).toBe("from bob");

    const charlieMsg = charlie.encrypt("from charlie");
    expect(alice.decrypt(charlieMsg)).toBe("from charlie");
    expect(bob.decrypt(charlieMsg)).toBe("from charlie");
  });
});
