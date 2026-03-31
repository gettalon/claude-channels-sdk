/**
 * Claude Channels SDK
 *
 * Build Claude Code channels with:
 * - Bidirectional chat (claude/channel)
 * - Permission relay (claude/channel/permission)
 * - All 23 hook events via command hooks + Unix socket IPC
 */
export { ChannelServer } from "./channel-server.js";
export { BLOCKING_EVENTS } from "./types.js";
// Built-in transports — core helpers kept at root
export { createUnixTransport, createWebSocketTransport, createStdioTransport } from "./transports/index.js";
// Hub — primary class and types (also available via @gettalon/channels-sdk/hub)
export { ChannelHub } from "./hub.js";
// Architect — agent MCP server helper
export { createAgentMcpServer, createArchitectServer } from "./architect.js";
// Agent config (tools layer)
export { loadAgentConfig, saveAgentConfig, listAgentConfigs, deleteAgentConfig } from "./agent-config.js";
// Mesh — E2E encryption and peer discovery utilities
export { generateIdentityKeyPair, loadOrCreateIdentity, deriveSharedSecret, E2eSession, SenderKeySession, MeshDiscovery, MeshRegistry, deriveMeshId, generateMeshSecret, createMeshJwt, verifyMeshJwt, deriveEncryptionKey, parseMeshConfig, } from "./mesh.js";
//# sourceMappingURL=index.js.map