/**
 * Subpath entry: @gettalon/channels-sdk/mesh
 *
 * Mesh networking — mDNS discovery, JWT auth, E2E encryption.
 */
export { deriveMeshId, generateMeshSecret, generateIdentityKeyPair, loadOrCreateIdentity, deriveSharedSecret, createMeshJwt, verifyMeshJwt, deriveEncryptionKey, parseMeshConfig, } from "../mesh.js";
export { E2eSession, SenderKeySession, MeshDiscovery, MeshRegistry, } from "../mesh.js";
export type { MeshConfig, MeshJwtPayload, EncryptedPayload, DiscoveredPeer, KeyPair, IdentityStore, SenderKeyBundle, SenderKeyDistribution, SenderKeyEncryptedMessage, } from "../mesh.js";
//# sourceMappingURL=mesh.d.ts.map