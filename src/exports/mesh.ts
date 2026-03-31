/**
 * Subpath entry: @gettalon/channels-sdk/mesh
 *
 * Mesh networking — mDNS discovery, JWT auth, E2E encryption.
 */

// Functions
export {
  deriveMeshId,
  generateMeshSecret,
  generateIdentityKeyPair,
  loadOrCreateIdentity,
  deriveSharedSecret,
  createMeshJwt,
  verifyMeshJwt,
  deriveEncryptionKey,
  parseMeshConfig,
} from "../mesh.js";

// Classes
export {
  E2eSession,
  SenderKeySession,
  MeshDiscovery,
  MeshRegistry,
} from "../mesh.js";

// Types
export type {
  MeshConfig,
  MeshJwtPayload,
  EncryptedPayload,
  DiscoveredPeer,
  KeyPair,
  IdentityStore,
  SenderKeyBundle,
  SenderKeyDistribution,
  SenderKeyEncryptedMessage,
} from "../mesh.js";
