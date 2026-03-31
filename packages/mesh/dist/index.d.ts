/**
 * Mesh Networking — mDNS discovery, JWT auth, E2E encryption
 *
 * Uses node:crypto for HMAC-SHA256 JWTs (compatible with relay server's
 * mesh-auth.ts format), PBKDF2 key derivation, and AES-256-GCM encryption.
 */
import { EventEmitter } from "node:events";
export interface MeshConfig {
    meshSecret: string;
    deviceId?: string;
    agentName?: string;
    port?: number;
    mdns?: boolean;
    registryUrl?: string;
    e2e?: boolean;
}
export interface DiscoveredPeer {
    id: string;
    name: string;
    ip: string;
    host: string;
    port: number;
    meshId?: string;
}
export interface EncryptedPayload {
    ciphertext: string;
    nonce: string;
    from: string;
}
export interface MeshJwtPayload {
    deviceId: string;
    meshId: string;
    iat: number;
    exp: number;
}
/**
 * Derive a mesh ID from a shared secret using HMAC-SHA256.
 * The relay server uses SHA-256 of the secret; we use HMAC-SHA256
 * with a fixed key to produce the same style hex digest.
 *
 * For compatibility with the relay's `sha256hex(meshSecret)`, we produce
 * a plain SHA-256 hex hash of the secret string.
 */
export declare function deriveMeshId(secret: string): string;
/**
 * Generate a cryptographically random 32-byte hex string for use as mesh secret.
 */
export declare function generateMeshSecret(): string;
/**
 * Create a JWT signed with HMAC-SHA256.
 * Format matches the relay server: header.payload.signature
 * Payload uses snake_case (mesh_id, device_id) for wire compatibility.
 */
export declare function createMeshJwt(secret: string, deviceId: string, ttlSeconds?: number): string;
/**
 * Verify a JWT and return the decoded payload, or null if invalid/expired.
 * Compatible with tokens created by both this SDK and the relay server.
 */
export declare function verifyMeshJwt(token: string, secret: string): MeshJwtPayload | null;
export interface KeyPair {
    publicKey: string;
    privateKey: string;
}
export interface IdentityStore {
    publicKey: string;
    privateKey: string;
    createdAt: string;
}
/**
 * Generate an X25519 keypair for ECDH key exchange.
 */
export declare function generateIdentityKeyPair(): KeyPair;
/**
 * Load or create identity keypair from ~/.talon/identity.json.
 */
export declare function loadOrCreateIdentity(talonHome?: string): Promise<IdentityStore>;
/**
 * Derive a shared secret from our private key and the peer's public key using X25519 ECDH.
 * Returns a 32-byte key suitable for AES-256-GCM.
 */
export declare function deriveSharedSecret(myPrivateKeyHex: string, peerPublicKeyHex: string): Buffer;
/**
 * Derive a 256-bit encryption key from a mesh secret using PBKDF2.
 * (Legacy mode — pre-shared key. New mode uses X25519 ECDH.)
 */
export declare function deriveEncryptionKey(secret: string, salt?: string): Buffer;
export declare class E2eSession {
    private key;
    private deviceId;
    private constructor();
    /**
     * Create an E2E session from a shared mesh secret and device identifier.
     * (Legacy mode — pre-shared key)
     */
    static fromMeshSecret(secret: string, deviceId: string): E2eSession;
    /**
     * Create an E2E session from X25519 ECDH key exchange.
     * (Signal-style — approval + key exchange, no pre-shared secret needed)
     */
    static fromKeyExchange(myPrivateKeyHex: string, peerPublicKeyHex: string, deviceId: string): E2eSession;
    /**
     * Encrypt data (string or object) using AES-256-GCM.
     * Returns an EncryptedPayload with hex-encoded ciphertext and nonce.
     */
    encrypt(data: unknown): EncryptedPayload;
    /**
     * Decrypt an EncryptedPayload back to the original string.
     */
    decrypt(payload: EncryptedPayload): string;
}
export interface SenderKeyBundle {
    /** The member who owns this sender key */
    owner: string;
    /** AES-256 key, hex-encoded */
    key: string;
    /** Monotonic chain index — increment on each rekey */
    chainIndex: number;
}
export interface SenderKeyDistribution {
    /** The member distributing their key */
    from: string;
    /** Encrypted sender key bundles — one per recipient, encrypted with pairwise E2eSession */
    bundles: Array<{
        to: string;
        encrypted: EncryptedPayload;
    }>;
    /** Chain index of the distributed key */
    chainIndex: number;
}
export interface SenderKeyEncryptedMessage {
    /** Sender's device/member ID */
    from: string;
    /** Group name */
    group: string;
    /** Chain index of the sender key used */
    chainIndex: number;
    /** AES-256-GCM encrypted payload */
    ciphertext: string;
    nonce: string;
}
export declare class SenderKeySession {
    /** Our own sender key for encrypting outbound messages */
    private ownKey;
    private ownKeyHex;
    private chainIndex;
    private deviceId;
    private group;
    /** Sender keys received from other members: memberId → { key, chainIndex } */
    private peerKeys;
    constructor(deviceId: string, group: string);
    /** Get our sender key bundle for distribution. */
    getKeyBundle(): SenderKeyBundle;
    /**
     * Distribute our sender key to all group members via their pairwise E2E sessions.
     * Returns encrypted bundles that the hub can forward to each member.
     */
    distribute(pairwiseSessions: Map<string, E2eSession>): SenderKeyDistribution;
    /**
     * Receive a sender key from another member (decrypted via pairwise E2E).
     */
    receiveSenderKey(bundle: SenderKeyBundle): void;
    /**
     * Process an incoming SenderKeyDistribution message.
     * Uses our pairwise E2eSession to decrypt the bundle addressed to us.
     */
    receiveDistribution(dist: SenderKeyDistribution, ourSession: E2eSession): void;
    /** Rekey — generate a new sender key. Must redistribute to all members. */
    rekey(): void;
    /**
     * Encrypt a message for the group using our sender key.
     * All members who have our sender key can decrypt.
     */
    encrypt(plaintext: string): SenderKeyEncryptedMessage;
    /**
     * Decrypt a group message using the sender's key.
     * @throws if sender key is unknown or chainIndex doesn't match
     */
    decrypt(msg: SenderKeyEncryptedMessage): string;
    /** Check if we have a sender key for a given member. */
    hasSenderKeyFor(memberId: string): boolean;
}
/**
 * Discover peers on the local network using mDNS (multicast DNS).
 * Falls back to an EventEmitter stub if multicast-dns is not installed.
 */
export declare class MeshDiscovery extends EventEmitter {
    private config;
    private mdns;
    private queryInterval;
    private peers;
    constructor(config: MeshConfig);
    start(): Promise<void>;
    private sendQuery;
    stop(): void;
}
/**
 * Connect to a relay server's registry endpoint to register this device
 * and discover remote peers outside the LAN.
 */
export declare class MeshRegistry {
    private secret;
    private deviceId;
    private baseUrl;
    private jwt;
    private reportTimer;
    constructor(secret: string, deviceId: string, url: string);
    /**
     * Register this device with the relay registry.
     */
    setup(): Promise<void>;
    /**
     * Start periodic heartbeat reporting to the registry.
     */
    startReporting(info: {
        lan?: Array<{
            ip: string;
            port: number;
        }>;
    }): void;
    /**
     * Fetch the list of known peers from the registry.
     */
    getPeers(): Promise<DiscoveredPeer[]>;
    stop(): void;
}
/**
 * Parse mesh configuration from environment variables.
 * Returns undefined if MESH_SECRET is not set.
 */
export declare function parseMeshConfig(env: Record<string, string | undefined>): MeshConfig | undefined;
//# sourceMappingURL=index.d.ts.map