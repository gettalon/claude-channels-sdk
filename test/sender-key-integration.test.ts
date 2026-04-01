/**
 * Phase 2: Sender key distribution integration tests.
 *
 * Verifies that agents can use group_members_list / group_member_joined
 * hub notifications to exchange SenderKeySession keys and achieve
 * end-to-end encrypted group messaging through the hub.
 *
 * Protocol used in these tests:
 *   - Key bundle is sent as a chat message: { type: "chat", target: id,
 *     content: JSON.stringify({ sender_key: bundle }) }
 *   - Hub routes it to the recipient who calls session.receiveSenderKey(bundle)
 *   - Encrypted group messages are sent as:
 *     { type: "chat", target: id, content: JSON.stringify({ group_msg: encMsg }) }
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ChannelHub } from "../dist/index.js";
import { SenderKeySession } from "../dist/mesh.js";
import { createTestHub, nextPort, delay, connectRawAgent } , startTestServer , startTestServer from "./helpers.js";

function cleanupHub(hub: ChannelHub) {
  (hub as any).stopHealthMonitor?.();
  for (const a of hub.agents.values()) try { a.ws?.close?.(); } catch {}
  for (const [, s] of hub.servers) { try { s.httpServer?.close(); s.wss?.close(); } catch {} }
  for (const [, c] of hub.clients) { try { c.ws?.close?.(); } catch {}; if (c.heartbeatTimer) clearInterval(c.heartbeatTimer); }
}

/** Parse a sender_key_bundle chat message. Returns the bundle or null. */
function parseSenderKeyMsg(msg: any): { owner: string; key: string; chainIndex: number } | null {
  if (msg?.type !== "chat") return null;
  try {
    const parsed = JSON.parse(msg.content);
    if (parsed?.sender_key) return parsed.sender_key;
  } catch {}
  return null;
}

/** Parse a group_msg chat message. Returns the encrypted message or null. */
function parseGroupMsg(msg: any) {
  if (msg?.type !== "chat") return null;
  try {
    const parsed = JSON.parse(msg.content);
    if (parsed?.group_msg) return parsed.group_msg;
  } catch {}
  return null;
}

describe("sender key integration (single hub)", () => {
  let hub: ChannelHub;
  let port: number;

  beforeEach(async () => {
    port = nextPort();
    hub = createTestHub({ name: "sk-hub" });
    await startTestServer(hub, port);
  });
  afterEach(() => cleanupHub(hub));

  it("first joiner creates a SenderKeySession with a valid bundle", async () => {
    const agA = await connectRawAgent(port, "alice-sk");
    const ackA = await agA.waitForMsg("register_ack");

    hub.createGroup("sk-group");
    hub.addToGroup("sk-group", ackA.agent_id);
    await delay(200);

    // No group_members_list — she is first
    expect(agA.messages.find((m: any) => m.type === "group_members_list")).toBeUndefined();

    // But she can still create a valid session
    const sessionA = new SenderKeySession(ackA.agent_id, "sk-group");
    const bundle = sessionA.getKeyBundle();
    expect(bundle.owner).toBe(ackA.agent_id);
    expect(bundle.key).toHaveLength(64); // 32 bytes hex
    expect(bundle.chainIndex).toBe(0);

    agA.close();
  });

  it("second joiner receives group_members_list and sends key bundle to first member", async () => {
    const agA = await connectRawAgent(port, "alice-sk2");
    const ackA = await agA.waitForMsg("register_ack");
    const agB = await connectRawAgent(port, "bob-sk2");
    const ackB = await agB.waitForMsg("register_ack");

    hub.createGroup("sk-group2");
    hub.addToGroup("sk-group2", ackA.agent_id);
    await delay(50);
    hub.addToGroup("sk-group2", ackB.agent_id);
    await delay(200);

    // Bob receives group_members_list with Alice
    const listMsg = agB.messages.find((m: any) => m.type === "group_members_list");
    expect(listMsg).toBeDefined();
    expect(listMsg.members[0].id).toBe(ackA.agent_id);

    // Bob creates a session and sends his key bundle to Alice
    const sessionB = new SenderKeySession(ackB.agent_id, "sk-group2");
    const bundleB = sessionB.getKeyBundle();
    agB.send({
      type: "chat",
      target: ackA.agent_id,
      content: JSON.stringify({ sender_key: bundleB }),
    });
    await delay(200);

    // Alice receives Bob's key bundle
    const keyMsg = agA.messages.find((m: any) => parseSenderKeyMsg(m) !== null);
    expect(keyMsg).toBeDefined();
    const receivedBundle = parseSenderKeyMsg(keyMsg);
    expect(receivedBundle!.owner).toBe(ackB.agent_id);

    agA.close(); agB.close();
  });

  it("first member receives group_member_joined and sends key bundle to new joiner", async () => {
    const agA = await connectRawAgent(port, "alice-sk3");
    const ackA = await agA.waitForMsg("register_ack");
    const agB = await connectRawAgent(port, "bob-sk3");
    const ackB = await agB.waitForMsg("register_ack");

    hub.createGroup("sk-group3");
    hub.addToGroup("sk-group3", ackA.agent_id);
    await delay(50);
    hub.addToGroup("sk-group3", ackB.agent_id);
    await delay(200);

    // Alice receives group_member_joined for Bob
    const joinMsg = agA.messages.find((m: any) => m.type === "group_member_joined");
    expect(joinMsg).toBeDefined();
    expect(joinMsg.memberId).toBe(ackB.agent_id);

    // Alice sends her key bundle to Bob
    const sessionA = new SenderKeySession(ackA.agent_id, "sk-group3");
    const bundleA = sessionA.getKeyBundle();
    agA.send({
      type: "chat",
      target: ackB.agent_id,
      content: JSON.stringify({ sender_key: bundleA }),
    });
    await delay(200);

    // Bob receives Alice's key bundle
    const keyMsg = agB.messages.find((m: any) => parseSenderKeyMsg(m) !== null);
    expect(keyMsg).toBeDefined();
    const receivedBundle = parseSenderKeyMsg(keyMsg);
    expect(receivedBundle!.owner).toBe(ackA.agent_id);

    agA.close(); agB.close();
  });

  it("full round-trip: mutual key exchange enables both to encrypt/decrypt", async () => {
    const agA = await connectRawAgent(port, "alice-sk4");
    const ackA = await agA.waitForMsg("register_ack");
    const agB = await connectRawAgent(port, "bob-sk4");
    const ackB = await agB.waitForMsg("register_ack");

    const sessionA = new SenderKeySession(ackA.agent_id, "sk-full");
    const sessionB = new SenderKeySession(ackB.agent_id, "sk-full");

    hub.createGroup("sk-full");
    hub.addToGroup("sk-full", ackA.agent_id);
    await delay(50);
    hub.addToGroup("sk-full", ackB.agent_id);
    await delay(200);

    // Alice → Bob: send Alice's key bundle on group_member_joined
    agA.send({ type: "chat", target: ackB.agent_id, content: JSON.stringify({ sender_key: sessionA.getKeyBundle() }) });
    // Bob → Alice: send Bob's key bundle on group_members_list
    agB.send({ type: "chat", target: ackA.agent_id, content: JSON.stringify({ sender_key: sessionB.getKeyBundle() }) });
    await delay(200);

    // Alice stores Bob's key
    const bobKeyMsg = agA.messages.find((m: any) => parseSenderKeyMsg(m) !== null);
    expect(bobKeyMsg).toBeDefined();
    sessionA.receiveSenderKey(parseSenderKeyMsg(bobKeyMsg)!);

    // Bob stores Alice's key
    const aliceKeyMsg = agB.messages.find((m: any) => parseSenderKeyMsg(m) !== null);
    expect(aliceKeyMsg).toBeDefined();
    sessionB.receiveSenderKey(parseSenderKeyMsg(aliceKeyMsg)!);

    // Bob encrypts a group message and sends to Alice
    const encByBob = sessionB.encrypt("hello from bob");
    agB.send({ type: "chat", target: ackA.agent_id, content: JSON.stringify({ group_msg: encByBob }) });
    await delay(200);

    // Alice decrypts it
    const bobGroupMsg = agA.messages.find((m: any) => parseGroupMsg(m) !== null);
    expect(bobGroupMsg).toBeDefined();
    const decrypted = sessionA.decrypt(parseGroupMsg(bobGroupMsg)!);
    expect(decrypted).toBe("hello from bob");

    // Alice encrypts a group message and sends to Bob
    const encByAlice = sessionA.encrypt("hello from alice");
    agA.send({ type: "chat", target: ackB.agent_id, content: JSON.stringify({ group_msg: encByAlice }) });
    await delay(200);

    // Bob decrypts it
    const aliceGroupMsg = agB.messages.find((m: any) => parseGroupMsg(m) !== null);
    expect(aliceGroupMsg).toBeDefined();
    const decryptedAlice = sessionB.decrypt(parseGroupMsg(aliceGroupMsg)!);
    expect(decryptedAlice).toBe("hello from alice");

    agA.close(); agB.close();
  });

  it("third joiner exchanges keys with all existing members", async () => {
    const agA = await connectRawAgent(port, "alice-sk5");
    const ackA = await agA.waitForMsg("register_ack");
    const agB = await connectRawAgent(port, "bob-sk5");
    const ackB = await agB.waitForMsg("register_ack");
    const agC = await connectRawAgent(port, "carol-sk5");
    const ackC = await agC.waitForMsg("register_ack");

    const sessionA = new SenderKeySession(ackA.agent_id, "sk-three");
    const sessionB = new SenderKeySession(ackB.agent_id, "sk-three");
    const sessionC = new SenderKeySession(ackC.agent_id, "sk-three");

    hub.createGroup("sk-three");
    hub.addToGroup("sk-three", ackA.agent_id);
    hub.addToGroup("sk-three", ackB.agent_id);
    await delay(50);
    hub.addToGroup("sk-three", ackC.agent_id);
    await delay(200);

    // Carol receives group_members_list with Alice + Bob → sends her key to both
    const listMsg = agC.messages.find((m: any) => m.type === "group_members_list");
    expect(listMsg).toBeDefined();
    expect(listMsg.members).toHaveLength(2);
    for (const { id } of listMsg.members) {
      agC.send({ type: "chat", target: id, content: JSON.stringify({ sender_key: sessionC.getKeyBundle() }) });
    }

    // Alice + Bob receive group_member_joined for Carol → each sends their key to Carol
    const joinA = agA.messages.find((m: any) => m.type === "group_member_joined" && m.memberId === ackC.agent_id);
    const joinB = agB.messages.find((m: any) => m.type === "group_member_joined" && m.memberId === ackC.agent_id);
    expect(joinA).toBeDefined();
    expect(joinB).toBeDefined();
    agA.send({ type: "chat", target: ackC.agent_id, content: JSON.stringify({ sender_key: sessionA.getKeyBundle() }) });
    agB.send({ type: "chat", target: ackC.agent_id, content: JSON.stringify({ sender_key: sessionB.getKeyBundle() }) });
    await delay(300);

    // Alice and Bob receive Carol's key
    const carolKeyForA = agA.messages.find((m: any) => parseSenderKeyMsg(m)?.owner === ackC.agent_id);
    const carolKeyForB = agB.messages.find((m: any) => parseSenderKeyMsg(m)?.owner === ackC.agent_id);
    expect(carolKeyForA).toBeDefined();
    expect(carolKeyForB).toBeDefined();
    sessionA.receiveSenderKey(parseSenderKeyMsg(carolKeyForA)!);
    sessionB.receiveSenderKey(parseSenderKeyMsg(carolKeyForB)!);

    // Carol receives Alice's and Bob's keys
    const aliceKeyForC = agC.messages.find((m: any) => parseSenderKeyMsg(m)?.owner === ackA.agent_id);
    const bobKeyForC = agC.messages.find((m: any) => parseSenderKeyMsg(m)?.owner === ackB.agent_id);
    expect(aliceKeyForC).toBeDefined();
    expect(bobKeyForC).toBeDefined();
    sessionC.receiveSenderKey(parseSenderKeyMsg(aliceKeyForC)!);
    sessionC.receiveSenderKey(parseSenderKeyMsg(bobKeyForC)!);

    // Carol sends an encrypted group message — Alice and Bob can decrypt
    const encByCarol = sessionC.encrypt("carol's secret");
    agC.send({ type: "chat", target: ackA.agent_id, content: JSON.stringify({ group_msg: encByCarol }) });
    agC.send({ type: "chat", target: ackB.agent_id, content: JSON.stringify({ group_msg: encByCarol }) });
    await delay(200);

    const carolMsgA = agA.messages.find((m: any) => parseGroupMsg(m) !== null);
    const carolMsgB = agB.messages.find((m: any) => parseGroupMsg(m) !== null);
    expect(carolMsgA).toBeDefined();
    expect(carolMsgB).toBeDefined();
    expect(sessionA.decrypt(parseGroupMsg(carolMsgA)!)).toBe("carol's secret");
    expect(sessionB.decrypt(parseGroupMsg(carolMsgB)!)).toBe("carol's secret");

    agA.close(); agB.close(); agC.close();
  });

  it("rekey invalidates old chain — decryption fails with old session, succeeds with new", async () => {
    const agA = await connectRawAgent(port, "alice-sk6");
    const ackA = await agA.waitForMsg("register_ack");
    const agB = await connectRawAgent(port, "bob-sk6");
    const ackB = await agB.waitForMsg("register_ack");

    const sessionA = new SenderKeySession(ackA.agent_id, "sk-rekey");
    const sessionB = new SenderKeySession(ackB.agent_id, "sk-rekey");

    // Initial key exchange
    sessionB.receiveSenderKey(sessionA.getKeyBundle());

    // Alice rekeys
    sessionA.rekey();

    // Bob tries to decrypt with old key — should throw
    const encAfterRekey = sessionA.encrypt("post-rekey message");
    expect(() => sessionB.decrypt(encAfterRekey)).toThrow();

    // Bob receives the new key bundle and can decrypt
    sessionB.receiveSenderKey(sessionA.getKeyBundle());
    const decrypted = sessionB.decrypt(encAfterRekey);
    expect(decrypted).toBe("post-rekey message");

    agA.close(); agB.close();
  });
});
