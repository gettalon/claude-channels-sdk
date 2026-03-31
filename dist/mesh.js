/**
 * Mesh Networking — mDNS discovery, JWT auth, E2E encryption
 *
 * Uses node:crypto for HMAC-SHA256 JWTs (compatible with relay server's
 * mesh-auth.ts format), PBKDF2 key derivation, and AES-256-GCM encryption.
 */
import { createHmac, randomBytes, pbkdf2Sync, createCipheriv, createDecipheriv } from "node:crypto";
import { EventEmitter } from "node:events";
// ── Base64url helpers (JWT-compatible) ─────────────────────────────────────────
function base64urlEncode(data) {
    return data.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function base64urlDecode(s) {
    let b64 = s.replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64.length % 4;
    if (pad === 2)
        b64 += "==";
    else if (pad === 3)
        b64 += "=";
    return Buffer.from(b64, "base64");
}
// ── Core utilities ─────────────────────────────────────────────────────────────
/**
 * Derive a mesh ID from a shared secret using HMAC-SHA256.
 * The relay server uses SHA-256 of the secret; we use HMAC-SHA256
 * with a fixed key to produce the same style hex digest.
 *
 * For compatibility with the relay's `sha256hex(meshSecret)`, we produce
 * a plain SHA-256 hex hash of the secret string.
 */
export function deriveMeshId(secret) {
    return createHmac("sha256", "mesh-id").update(secret).digest("hex");
}
/**
 * Generate a cryptographically random 32-byte hex string for use as mesh secret.
 */
export function generateMeshSecret() {
    return randomBytes(32).toString("hex");
}
// ── JWT (HMAC-SHA256, compatible with relay mesh-auth.ts) ──────────────────────
/**
 * Create a JWT signed with HMAC-SHA256.
 * Format matches the relay server: header.payload.signature
 * Payload uses snake_case (mesh_id, device_id) for wire compatibility.
 */
export function createMeshJwt(secret, deviceId, ttlSeconds = 3600) {
    const meshId = deriveMeshId(secret);
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: "HS256", typ: "JWT" };
    const payload = {
        mesh_id: meshId,
        device_id: deviceId,
        iat: now,
        exp: now + ttlSeconds,
    };
    const headerB64 = base64urlEncode(Buffer.from(JSON.stringify(header)));
    const payloadB64 = base64urlEncode(Buffer.from(JSON.stringify(payload)));
    const signingInput = `${headerB64}.${payloadB64}`;
    const signature = createHmac("sha256", secret).update(signingInput).digest();
    return `${signingInput}.${base64urlEncode(signature)}`;
}
/**
 * Verify a JWT and return the decoded payload, or null if invalid/expired.
 * Compatible with tokens created by both this SDK and the relay server.
 */
export function verifyMeshJwt(token, secret) {
    const parts = token.split(".");
    if (parts.length !== 3)
        return null;
    const [headerB64, payloadB64, signatureB64] = parts;
    const signingInput = `${headerB64}.${payloadB64}`;
    let expectedSig;
    try {
        expectedSig = createHmac("sha256", secret).update(signingInput).digest();
    }
    catch {
        return null;
    }
    let actualSig;
    try {
        actualSig = base64urlDecode(signatureB64);
    }
    catch {
        return null;
    }
    // Constant-time comparison
    if (expectedSig.length !== actualSig.length)
        return null;
    let diff = 0;
    for (let i = 0; i < expectedSig.length; i++) {
        diff |= expectedSig[i] ^ actualSig[i];
    }
    if (diff !== 0)
        return null;
    let raw;
    try {
        raw = JSON.parse(base64urlDecode(payloadB64).toString("utf8"));
    }
    catch {
        return null;
    }
    // Accept both snake_case (relay) and camelCase (local) field names
    const meshId = (raw.mesh_id ?? raw.meshId);
    const devId = (raw.device_id ?? raw.deviceId);
    const iat = raw.iat;
    const exp = raw.exp;
    if (!meshId || !devId || typeof iat !== "number" || typeof exp !== "number")
        return null;
    if (exp <= Math.floor(Date.now() / 1000))
        return null;
    return { meshId, deviceId: devId, iat, exp };
}
// ── X25519 Key Exchange (Signal-style) ────────────────────────────────────────
import { generateKeyPairSync, diffieHellman } from "node:crypto";
/**
 * Generate an X25519 keypair for ECDH key exchange.
 */
export function generateIdentityKeyPair() {
    const { publicKey, privateKey } = generateKeyPairSync("x25519", {
        publicKeyEncoding: { type: "spki", format: "der" },
        privateKeyEncoding: { type: "pkcs8", format: "der" },
    });
    return {
        publicKey: Buffer.from(publicKey).toString("hex"),
        privateKey: Buffer.from(privateKey).toString("hex"),
    };
}
/**
 * Load or create identity keypair from ~/.talon/identity.json.
 */
export async function loadOrCreateIdentity(talonHome) {
    const { readFile, writeFile, mkdir } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { homedir } = await import("node:os");
    const dir = talonHome ?? join(homedir(), ".talon");
    const path = join(dir, "identity.json");
    try {
        const raw = await readFile(path, "utf-8");
        return JSON.parse(raw);
    }
    catch {
        const kp = generateIdentityKeyPair();
        const identity = { ...kp, createdAt: new Date().toISOString() };
        await mkdir(dir, { recursive: true });
        await writeFile(path, JSON.stringify(identity, null, 2));
        return identity;
    }
}
/**
 * Derive a shared secret from our private key and the peer's public key using X25519 ECDH.
 * Returns a 32-byte key suitable for AES-256-GCM.
 */
export function deriveSharedSecret(myPrivateKeyHex, peerPublicKeyHex) {
    const { createPrivateKey, createPublicKey } = require("node:crypto");
    const myKey = createPrivateKey({ key: Buffer.from(myPrivateKeyHex, "hex"), format: "der", type: "pkcs8" });
    const peerKey = createPublicKey({ key: Buffer.from(peerPublicKeyHex, "hex"), format: "der", type: "spki" });
    return diffieHellman({ privateKey: myKey, publicKey: peerKey });
}
// ── E2E Encryption (AES-256-GCM) ──────────────────────────────────────────────
const PBKDF2_ITERATIONS = 100_000;
const KEY_LENGTH = 32; // 256 bits
const IV_LENGTH = 12; // 96 bits for GCM
const AUTH_TAG_LENGTH = 16; // 128 bits
/**
 * Derive a 256-bit encryption key from a mesh secret using PBKDF2.
 * (Legacy mode — pre-shared key. New mode uses X25519 ECDH.)
 */
export function deriveEncryptionKey(secret, salt = "mesh-e2e-key") {
    return pbkdf2Sync(secret, salt, PBKDF2_ITERATIONS, KEY_LENGTH, "sha256");
}
export class E2eSession {
    key;
    deviceId;
    constructor(key, deviceId) {
        this.key = key;
        this.deviceId = deviceId;
    }
    /**
     * Create an E2E session from a shared mesh secret and device identifier.
     * (Legacy mode — pre-shared key)
     */
    static fromMeshSecret(secret, deviceId) {
        const key = deriveEncryptionKey(secret);
        return new E2eSession(key, deviceId);
    }
    /**
     * Create an E2E session from X25519 ECDH key exchange.
     * (Signal-style — approval + key exchange, no pre-shared secret needed)
     */
    static fromKeyExchange(myPrivateKeyHex, peerPublicKeyHex, deviceId) {
        const sharedSecret = deriveSharedSecret(myPrivateKeyHex, peerPublicKeyHex);
        return new E2eSession(sharedSecret, deviceId);
    }
    /**
     * Encrypt data (string or object) using AES-256-GCM.
     * Returns an EncryptedPayload with hex-encoded ciphertext and nonce.
     */
    encrypt(data) {
        const plaintext = typeof data === "string" ? data : JSON.stringify(data);
        const iv = randomBytes(IV_LENGTH);
        const cipher = createCipheriv("aes-256-gcm", this.key, iv, { authTagLength: AUTH_TAG_LENGTH });
        const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
        const authTag = cipher.getAuthTag();
        // Concatenate ciphertext + auth tag for transport
        const combined = Buffer.concat([encrypted, authTag]);
        return {
            ciphertext: combined.toString("hex"),
            nonce: iv.toString("hex"),
            from: this.deviceId,
        };
    }
    /**
     * Decrypt an EncryptedPayload back to the original string.
     */
    decrypt(payload) {
        const combined = Buffer.from(payload.ciphertext, "hex");
        const iv = Buffer.from(payload.nonce, "hex");
        // Split ciphertext and auth tag
        const encrypted = combined.subarray(0, combined.length - AUTH_TAG_LENGTH);
        const authTag = combined.subarray(combined.length - AUTH_TAG_LENGTH);
        const decipher = createDecipheriv("aes-256-gcm", this.key, iv, { authTagLength: AUTH_TAG_LENGTH });
        decipher.setAuthTag(authTag);
        const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
        return decrypted.toString("utf8");
    }
}
export class SenderKeySession {
    /** Our own sender key for encrypting outbound messages */
    ownKey;
    ownKeyHex;
    chainIndex;
    deviceId;
    group;
    /** Sender keys received from other members: memberId → { key, chainIndex } */
    peerKeys = new Map();
    constructor(deviceId, group) {
        this.deviceId = deviceId;
        this.group = group;
        this.ownKey = randomBytes(KEY_LENGTH);
        this.ownKeyHex = this.ownKey.toString("hex");
        this.chainIndex = 0;
    }
    /** Get our sender key bundle for distribution. */
    getKeyBundle() {
        return { owner: this.deviceId, key: this.ownKeyHex, chainIndex: this.chainIndex };
    }
    /**
     * Distribute our sender key to all group members via their pairwise E2E sessions.
     * Returns encrypted bundles that the hub can forward to each member.
     */
    distribute(pairwiseSessions) {
        const bundles = [];
        const bundleData = JSON.stringify(this.getKeyBundle());
        for (const [memberId, session] of pairwiseSessions) {
            bundles.push({ to: memberId, encrypted: session.encrypt(bundleData) });
        }
        return { from: this.deviceId, bundles, chainIndex: this.chainIndex };
    }
    /**
     * Receive a sender key from another member (decrypted via pairwise E2E).
     */
    receiveSenderKey(bundle) {
        this.peerKeys.set(bundle.owner, {
            key: Buffer.from(bundle.key, "hex"),
            chainIndex: bundle.chainIndex,
        });
    }
    /**
     * Process an incoming SenderKeyDistribution message.
     * Uses our pairwise E2eSession to decrypt the bundle addressed to us.
     */
    receiveDistribution(dist, ourSession) {
        const forUs = dist.bundles.find(b => b.to === this.deviceId);
        if (!forUs)
            return;
        const decrypted = ourSession.decrypt(forUs.encrypted);
        const bundle = JSON.parse(decrypted);
        this.receiveSenderKey(bundle);
    }
    /** Rekey — generate a new sender key. Must redistribute to all members. */
    rekey() {
        this.ownKey = randomBytes(KEY_LENGTH);
        this.ownKeyHex = this.ownKey.toString("hex");
        this.chainIndex++;
    }
    /**
     * Encrypt a message for the group using our sender key.
     * All members who have our sender key can decrypt.
     */
    encrypt(plaintext) {
        const iv = randomBytes(IV_LENGTH);
        const cipher = createCipheriv("aes-256-gcm", this.ownKey, iv, { authTagLength: AUTH_TAG_LENGTH });
        const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
        const authTag = cipher.getAuthTag();
        return {
            from: this.deviceId,
            group: this.group,
            chainIndex: this.chainIndex,
            ciphertext: Buffer.concat([encrypted, authTag]).toString("hex"),
            nonce: iv.toString("hex"),
        };
    }
    /**
     * Decrypt a group message using the sender's key.
     * @throws if sender key is unknown or chainIndex doesn't match
     */
    decrypt(msg) {
        const peer = this.peerKeys.get(msg.from);
        if (!peer)
            throw new Error(`No sender key for "${msg.from}"`);
        if (peer.chainIndex !== msg.chainIndex)
            throw new Error(`Chain index mismatch: expected ${peer.chainIndex}, got ${msg.chainIndex}`);
        const combined = Buffer.from(msg.ciphertext, "hex");
        const iv = Buffer.from(msg.nonce, "hex");
        const encrypted = combined.subarray(0, combined.length - AUTH_TAG_LENGTH);
        const authTag = combined.subarray(combined.length - AUTH_TAG_LENGTH);
        const decipher = createDecipheriv("aes-256-gcm", peer.key, iv, { authTagLength: AUTH_TAG_LENGTH });
        decipher.setAuthTag(authTag);
        return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
    }
    /** Check if we have a sender key for a given member. */
    hasSenderKeyFor(memberId) {
        return this.peerKeys.has(memberId);
    }
}
// ── mDNS Peer Discovery ────────────────────────────────────────────────────────
const MDNS_SERVICE_TYPE = "_talon-mesh._tcp.local";
/**
 * Discover peers on the local network using mDNS (multicast DNS).
 * Falls back to an EventEmitter stub if multicast-dns is not installed.
 */
export class MeshDiscovery extends EventEmitter {
    config;
    mdns = null;
    queryInterval = null;
    peers = new Map();
    constructor(config) {
        super();
        this.config = config;
    }
    async start() {
        let mdnsModule;
        try {
            mdnsModule = await import("multicast-dns");
        }
        catch {
            // multicast-dns not available; emit a warning and operate as a no-op
            process.stderr.write("[mesh-discovery] multicast-dns package not installed, mDNS discovery disabled\n");
            return;
        }
        const mdnsCreate = mdnsModule.default ?? mdnsModule;
        this.mdns = mdnsCreate();
        // Respond to queries about our service
        this.mdns.on("query", (query) => {
            const isOurs = query.questions?.some((q) => q.name === MDNS_SERVICE_TYPE || q.name?.endsWith("._talon-mesh._tcp.local"));
            if (!isOurs)
                return;
            const meshId = deriveMeshId(this.config.meshSecret);
            const name = this.config.agentName ?? `agent-${process.pid}`;
            const port = this.config.port ?? 3000;
            this.mdns.respond({
                answers: [
                    {
                        name: `${name}.${MDNS_SERVICE_TYPE}`,
                        type: "SRV",
                        data: { port, target: `${name}.local` },
                    },
                    {
                        name: `${name}.${MDNS_SERVICE_TYPE}`,
                        type: "TXT",
                        data: [`meshId=${meshId}`, `deviceId=${this.config.deviceId ?? name}`],
                    },
                ],
            });
        });
        // Handle responses from peers
        this.mdns.on("response", (response) => {
            const srvRecord = response.answers?.find((a) => a.type === "SRV" && a.name?.includes("_talon-mesh"));
            const txtRecord = response.answers?.find((a) => a.type === "TXT" && a.name?.includes("_talon-mesh"));
            if (!srvRecord)
                return;
            const peerName = srvRecord.name?.split(".")[0] ?? "unknown";
            const peerPort = srvRecord.data?.port ?? 3000;
            const peerHost = srvRecord.data?.target ?? "localhost";
            // Parse TXT record for meshId and deviceId
            let meshId;
            let deviceId;
            if (txtRecord?.data) {
                const txtEntries = Array.isArray(txtRecord.data)
                    ? txtRecord.data.map((d) => (typeof d === "string" ? d : d.toString()))
                    : [txtRecord.data.toString()];
                for (const entry of txtEntries) {
                    if (entry.startsWith("meshId="))
                        meshId = entry.slice(7);
                    if (entry.startsWith("deviceId="))
                        deviceId = entry.slice(9);
                }
            }
            // Only accept peers from the same mesh
            const ourMeshId = deriveMeshId(this.config.meshSecret);
            if (meshId && meshId !== ourMeshId)
                return;
            // Derive a peer IP from additional records if available
            const aRecord = response.additionals?.find((a) => a.type === "A");
            const peerIp = aRecord?.data ?? "0.0.0.0";
            const peer = {
                id: deviceId ?? peerName,
                name: peerName,
                ip: peerIp,
                host: peerHost,
                port: peerPort,
                meshId,
            };
            // Skip self
            const selfName = this.config.agentName ?? `agent-${process.pid}`;
            if (peer.name === selfName && peer.id === (this.config.deviceId ?? selfName))
                return;
            const key = `${peer.id}@${peer.ip}:${peer.port}`;
            if (!this.peers.has(key)) {
                this.peers.set(key, peer);
                this.emit("peerDiscovered", peer);
            }
        });
        // Send initial query and repeat periodically
        this.sendQuery();
        this.queryInterval = setInterval(() => this.sendQuery(), 10_000);
    }
    sendQuery() {
        if (!this.mdns)
            return;
        this.mdns.query({
            questions: [{ name: MDNS_SERVICE_TYPE, type: "PTR" }],
        });
    }
    stop() {
        if (this.queryInterval) {
            clearInterval(this.queryInterval);
            this.queryInterval = null;
        }
        if (this.mdns) {
            try {
                this.mdns.destroy();
            }
            catch { /* ignore */ }
            this.mdns = null;
        }
        this.peers.clear();
    }
}
// ── Mesh Registry (relay server integration) ───────────────────────────────────
/**
 * Connect to a relay server's registry endpoint to register this device
 * and discover remote peers outside the LAN.
 */
export class MeshRegistry {
    secret;
    deviceId;
    baseUrl;
    jwt;
    reportTimer = null;
    constructor(secret, deviceId, url) {
        this.secret = secret;
        this.deviceId = deviceId;
        this.baseUrl = url.replace(/\/$/, "");
        this.jwt = createMeshJwt(secret, deviceId);
    }
    /**
     * Register this device with the relay registry.
     */
    async setup() {
        const meshId = deriveMeshId(this.secret);
        const res = await fetch(`${this.baseUrl}/mesh/register`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${this.jwt}`,
            },
            body: JSON.stringify({
                mesh_id: meshId,
                device_id: this.deviceId,
            }),
        });
        if (!res.ok) {
            const text = await res.text().catch(() => "");
            throw new Error(`Registry registration failed (${res.status}): ${text}`);
        }
    }
    /**
     * Start periodic heartbeat reporting to the registry.
     */
    startReporting(info) {
        const report = async () => {
            try {
                // Refresh JWT before each report
                this.jwt = createMeshJwt(this.secret, this.deviceId);
                await fetch(`${this.baseUrl}/mesh/heartbeat`, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        Authorization: `Bearer ${this.jwt}`,
                    },
                    body: JSON.stringify({
                        device_id: this.deviceId,
                        mesh_id: deriveMeshId(this.secret),
                        lan: info.lan ?? [],
                        timestamp: Date.now(),
                    }),
                });
            }
            catch {
                // Silently ignore heartbeat failures
            }
        };
        // Send first heartbeat immediately, then every 30 seconds
        report();
        this.reportTimer = setInterval(report, 30_000);
    }
    /**
     * Fetch the list of known peers from the registry.
     */
    async getPeers() {
        this.jwt = createMeshJwt(this.secret, this.deviceId);
        const meshId = deriveMeshId(this.secret);
        const res = await fetch(`${this.baseUrl}/mesh/peers?mesh_id=${encodeURIComponent(meshId)}`, {
            headers: { Authorization: `Bearer ${this.jwt}` },
        });
        if (!res.ok)
            return [];
        const data = (await res.json());
        if (!Array.isArray(data.peers))
            return [];
        return data.peers.map((p) => ({
            id: String(p.device_id ?? p.id ?? "unknown"),
            name: String(p.name ?? p.device_id ?? "unknown"),
            ip: String(p.ip ?? "0.0.0.0"),
            host: String(p.host ?? p.ip ?? "localhost"),
            port: Number(p.port ?? 3000),
            meshId: String(p.mesh_id ?? meshId),
        }));
    }
    stop() {
        if (this.reportTimer) {
            clearInterval(this.reportTimer);
            this.reportTimer = null;
        }
    }
}
// ── Config parser ──────────────────────────────────────────────────────────────
/**
 * Parse mesh configuration from environment variables.
 * Returns undefined if MESH_SECRET is not set.
 */
export function parseMeshConfig(env) {
    if (!env.MESH_SECRET)
        return undefined;
    return {
        meshSecret: env.MESH_SECRET,
        deviceId: env.MESH_DEVICE_ID,
        agentName: env.WS_AGENT_NAME,
        port: env.WS_PORT ? parseInt(env.WS_PORT, 10) : undefined,
        mdns: env.MESH_MDNS !== "false",
        registryUrl: env.MESH_RELAY_URL,
        e2e: env.MESH_E2E === "true",
    };
}
//# sourceMappingURL=mesh.js.map