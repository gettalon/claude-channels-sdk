/**
 * Mesh networking module tests.
 *
 * Covers: deriveMeshId, generateMeshSecret, createMeshJwt, verifyMeshJwt,
 * deriveEncryptionKey, E2eSession, and parseMeshConfig.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  deriveMeshId,
  generateMeshSecret,
  createMeshJwt,
  verifyMeshJwt,
  deriveEncryptionKey,
  E2eSession,
  parseMeshConfig,
} from "../dist/index.js";
import type { MeshConfig, MeshJwtPayload, EncryptedPayload } from "../dist/index.js";

// ── deriveMeshId ────────────────────────────────────────────────────────────

describe("deriveMeshId", () => {
  it("returns a 64-character hex string (SHA-256 digest)", () => {
    const id = deriveMeshId("test-secret");
    expect(id).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic — same input yields same output", () => {
    const a = deriveMeshId("my-mesh-secret");
    const b = deriveMeshId("my-mesh-secret");
    expect(a).toBe(b);
  });

  it("produces different IDs for different secrets", () => {
    const a = deriveMeshId("secret-one");
    const b = deriveMeshId("secret-two");
    expect(a).not.toBe(b);
  });

  it("handles empty string input", () => {
    const id = deriveMeshId("");
    expect(id).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ── generateMeshSecret ──────────────────────────────────────────────────────

describe("generateMeshSecret", () => {
  it("returns a 64-character hex string (32 bytes)", () => {
    const secret = generateMeshSecret();
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
  });

  it("generates unique values on each call", () => {
    const secrets = new Set(Array.from({ length: 20 }, () => generateMeshSecret()));
    expect(secrets.size).toBe(20);
  });
});

// ── createMeshJwt + verifyMeshJwt ───────────────────────────────────────────

describe("createMeshJwt / verifyMeshJwt", () => {
  const secret = "round-trip-secret";
  const deviceId = "device-42";

  it("creates a JWT with three dot-separated parts", () => {
    const token = createMeshJwt(secret, deviceId);
    const parts = token.split(".");
    expect(parts).toHaveLength(3);
    // Each part must be non-empty base64url
    for (const part of parts) {
      expect(part.length).toBeGreaterThan(0);
      expect(part).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it("round-trips: verifyMeshJwt returns the correct payload", () => {
    const token = createMeshJwt(secret, deviceId);
    const payload = verifyMeshJwt(token, secret);
    expect(payload).not.toBeNull();
    expect(payload!.deviceId).toBe(deviceId);
    expect(payload!.meshId).toBe(deriveMeshId(secret));
    expect(typeof payload!.iat).toBe("number");
    expect(typeof payload!.exp).toBe("number");
    expect(payload!.exp).toBeGreaterThan(payload!.iat);
  });

  it("respects custom TTL", () => {
    const token = createMeshJwt(secret, deviceId, 120);
    const payload = verifyMeshJwt(token, secret);
    expect(payload).not.toBeNull();
    expect(payload!.exp - payload!.iat).toBe(120);
  });

  it("defaults to 3600s TTL", () => {
    const token = createMeshJwt(secret, deviceId);
    const payload = verifyMeshJwt(token, secret);
    expect(payload).not.toBeNull();
    expect(payload!.exp - payload!.iat).toBe(3600);
  });

  it("rejects a token signed with a different secret", () => {
    const token = createMeshJwt(secret, deviceId);
    const payload = verifyMeshJwt(token, "wrong-secret");
    expect(payload).toBeNull();
  });

  it("rejects a tampered token", () => {
    const token = createMeshJwt(secret, deviceId);
    // Flip a character in the payload section
    const parts = token.split(".");
    const tamperedPayload =
      parts[1]![0] === "a"
        ? "b" + parts[1]!.slice(1)
        : "a" + parts[1]!.slice(1);
    const tampered = `${parts[0]}.${tamperedPayload}.${parts[2]}`;
    expect(verifyMeshJwt(tampered, secret)).toBeNull();
  });

  it("rejects a malformed token (wrong number of parts)", () => {
    expect(verifyMeshJwt("only-one-part", secret)).toBeNull();
    expect(verifyMeshJwt("two.parts", secret)).toBeNull();
    expect(verifyMeshJwt("four.parts.here.extra", secret)).toBeNull();
  });

  it("rejects an expired token", () => {
    // Create a token that expired 10 seconds ago
    const token = createMeshJwt(secret, deviceId, -10);
    expect(verifyMeshJwt(token, secret)).toBeNull();
  });
});

// ── deriveEncryptionKey ─────────────────────────────────────────────────────

describe("deriveEncryptionKey", () => {
  it("returns a 32-byte Buffer (256-bit key)", () => {
    const key = deriveEncryptionKey("my-secret");
    expect(Buffer.isBuffer(key)).toBe(true);
    expect(key.length).toBe(32);
  });

  it("is deterministic with same secret and salt", () => {
    const a = deriveEncryptionKey("s", "salt");
    const b = deriveEncryptionKey("s", "salt");
    expect(a.equals(b)).toBe(true);
  });

  it("produces different keys for different secrets", () => {
    const a = deriveEncryptionKey("secret-a");
    const b = deriveEncryptionKey("secret-b");
    expect(a.equals(b)).toBe(false);
  });

  it("produces different keys for different salts", () => {
    const a = deriveEncryptionKey("same-secret", "salt-1");
    const b = deriveEncryptionKey("same-secret", "salt-2");
    expect(a.equals(b)).toBe(false);
  });

  it("uses a default salt when none is provided", () => {
    const a = deriveEncryptionKey("x");
    const b = deriveEncryptionKey("x", "mesh-e2e-key");
    expect(a.equals(b)).toBe(true);
  });
});

// ── E2eSession ──────────────────────────────────────────────────────────────

describe("E2eSession", () => {
  const secret = "e2e-test-secret";
  const deviceA = "device-a";
  const deviceB = "device-b";

  it("encrypts and decrypts a plain string", () => {
    const session = E2eSession.fromMeshSecret(secret, deviceA);
    const encrypted = session.encrypt("hello mesh");
    expect(encrypted.ciphertext).not.toBe("hello mesh");
    expect(encrypted.from).toBe(deviceA);
    expect(encrypted.nonce).toBeTruthy();

    const decrypted = session.decrypt(encrypted);
    expect(decrypted).toBe("hello mesh");
  });

  it("encrypts and decrypts an object (JSON round-trip)", () => {
    const session = E2eSession.fromMeshSecret(secret, deviceA);
    const obj = { action: "ping", ts: 12345 };
    const encrypted = session.encrypt(obj);
    const decrypted = session.decrypt(encrypted);
    expect(JSON.parse(decrypted)).toEqual(obj);
  });

  it("two sessions with the same secret can decrypt each other's messages", () => {
    const sessionA = E2eSession.fromMeshSecret(secret, deviceA);
    const sessionB = E2eSession.fromMeshSecret(secret, deviceB);

    const encrypted = sessionA.encrypt("from A to B");
    expect(encrypted.from).toBe(deviceA);

    const decrypted = sessionB.decrypt(encrypted);
    expect(decrypted).toBe("from A to B");
  });

  it("a session with a different secret cannot decrypt the message", () => {
    const sessionA = E2eSession.fromMeshSecret(secret, deviceA);
    const sessionBad = E2eSession.fromMeshSecret("wrong-secret", deviceB);

    const encrypted = sessionA.encrypt("secret data");
    expect(() => sessionBad.decrypt(encrypted)).toThrow();
  });

  it("produces different ciphertext for the same plaintext (random IV)", () => {
    const session = E2eSession.fromMeshSecret(secret, deviceA);
    const e1 = session.encrypt("same text");
    const e2 = session.encrypt("same text");
    expect(e1.ciphertext).not.toBe(e2.ciphertext);
    expect(e1.nonce).not.toBe(e2.nonce);
  });

  it("ciphertext and nonce are hex strings", () => {
    const session = E2eSession.fromMeshSecret(secret, deviceA);
    const encrypted = session.encrypt("hex check");
    expect(encrypted.ciphertext).toMatch(/^[0-9a-f]+$/);
    // IV is 12 bytes = 24 hex chars
    expect(encrypted.nonce).toMatch(/^[0-9a-f]{24}$/);
  });

  it("handles empty string encryption", () => {
    const session = E2eSession.fromMeshSecret(secret, deviceA);
    const encrypted = session.encrypt("");
    const decrypted = session.decrypt(encrypted);
    expect(decrypted).toBe("");
  });

  it("handles large payloads", () => {
    const session = E2eSession.fromMeshSecret(secret, deviceA);
    const large = "x".repeat(100_000);
    const encrypted = session.encrypt(large);
    const decrypted = session.decrypt(encrypted);
    expect(decrypted).toBe(large);
  });

  it("rejects tampered ciphertext", () => {
    const session = E2eSession.fromMeshSecret(secret, deviceA);
    const encrypted = session.encrypt("important");
    // Flip a hex character in the ciphertext
    const flipped = encrypted.ciphertext[0] === "a" ? "b" : "a";
    const tampered: EncryptedPayload = {
      ...encrypted,
      ciphertext: flipped + encrypted.ciphertext.slice(1),
    };
    expect(() => session.decrypt(tampered)).toThrow();
  });
});

// ── parseMeshConfig ─────────────────────────────────────────────────────────

describe("parseMeshConfig", () => {
  it("returns undefined when MESH_SECRET is not set", () => {
    expect(parseMeshConfig({})).toBeUndefined();
    expect(parseMeshConfig({ MESH_DEVICE_ID: "d1" })).toBeUndefined();
  });

  it("returns a MeshConfig when MESH_SECRET is set", () => {
    const config = parseMeshConfig({ MESH_SECRET: "abc" });
    expect(config).toBeDefined();
    expect(config!.meshSecret).toBe("abc");
  });

  it("maps all environment variables to config fields", () => {
    const config = parseMeshConfig({
      MESH_SECRET: "s",
      MESH_DEVICE_ID: "dev-1",
      WS_AGENT_NAME: "my-agent",
      WS_PORT: "4567",
      MESH_MDNS: "true",
      MESH_RELAY_URL: "https://relay.example.com",
      MESH_E2E: "true",
    });
    expect(config).toEqual({
      meshSecret: "s",
      deviceId: "dev-1",
      agentName: "my-agent",
      port: 4567,
      mdns: true,
      registryUrl: "https://relay.example.com",
      e2e: true,
    });
  });

  it("parses port as integer", () => {
    const config = parseMeshConfig({ MESH_SECRET: "s", WS_PORT: "8080" });
    expect(config!.port).toBe(8080);
  });

  it("port is undefined when WS_PORT is not set", () => {
    const config = parseMeshConfig({ MESH_SECRET: "s" });
    expect(config!.port).toBeUndefined();
  });

  it("mdns defaults to true when MESH_MDNS is not set", () => {
    const config = parseMeshConfig({ MESH_SECRET: "s" });
    expect(config!.mdns).toBe(true);
  });

  it("mdns is false only when MESH_MDNS is explicitly 'false'", () => {
    const off = parseMeshConfig({ MESH_SECRET: "s", MESH_MDNS: "false" });
    expect(off!.mdns).toBe(false);

    const on = parseMeshConfig({ MESH_SECRET: "s", MESH_MDNS: "yes" });
    expect(on!.mdns).toBe(true);
  });

  it("e2e is true only when MESH_E2E is 'true'", () => {
    const off = parseMeshConfig({ MESH_SECRET: "s" });
    expect(off!.e2e).toBe(false);

    const on = parseMeshConfig({ MESH_SECRET: "s", MESH_E2E: "true" });
    expect(on!.e2e).toBe(true);

    const other = parseMeshConfig({ MESH_SECRET: "s", MESH_E2E: "yes" });
    expect(other!.e2e).toBe(false);
  });

  it("optional fields are undefined when not provided", () => {
    const config = parseMeshConfig({ MESH_SECRET: "s" });
    expect(config!.deviceId).toBeUndefined();
    expect(config!.agentName).toBeUndefined();
    expect(config!.registryUrl).toBeUndefined();
  });
});
