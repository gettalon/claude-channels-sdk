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
// Protocol (transport-agnostic)
export { MessageType, serialize, deserialize, serializeBuffer, deserializeBuffer, createEnvelope } from "./protocol.js";
// Built-in transports (auto-registered: unix, websocket, stdio, telegram)
export { UnixSocketAdapter, createUnixTransport, WebSocketAdapter, createWebSocketTransport, TelegramAdapter, createTelegramTransport, StdioAdapter, StdioTransport, createStdioTransport } from "./transports/index.js";
// Application-level channel adapters as transports (auto-registered: discord, slack, whatsapp, matrix, signal, irc, line, feishu, msteams)
export { createDiscordTransport, createSlackTransport, createWhatsAppTransport, createMatrixTransport, createSignalTransport, createIrcTransport, createLineTransport, createFeishuTransport, createMsTeamsTransport, } from "./transports/index.js";
// Channel Hub (SDK-level connection manager)
export { ChannelHub } from "./hub.js";
// Hub commands (command registry + built-in /hooks, /status, /agents)
export { registerCommand, unregisterCommand, getCommand, listCommands, parseHubCommand, executeCommand, areHooksVisible, setHooksVisible, loadTalonSettings, saveTalonSettings, } from "./hub-commands.js";
// Architect (MCP wrapper around ChannelHub)
export { createArchitectServer, createAgentMcpServer } from "./architect.js";
// Daemon mode (run ChannelHub as background process)
export { daemonStart, daemonStop, daemonRestart, daemonStatus } from "./daemon.js";
// Persistent agent launcher
export { launchAgent, stopAgent, sendToAgent, listRunningAgents, getAgent, getAgentStatus, agentFolder, AsyncQueue } from "./tools/agent-launcher.js";
// Per-agent config
export { loadAgentConfig, saveAgentConfig, listAgentConfigs, deleteAgentConfig, migrateSettingsToPerAgent } from "./agent-config.js";
// Mesh networking
export { deriveMeshId, generateMeshSecret, generateIdentityKeyPair, loadOrCreateIdentity, deriveSharedSecret, createMeshJwt, verifyMeshJwt, deriveEncryptionKey, E2eSession, SenderKeySession, MeshDiscovery, MeshRegistry, parseMeshConfig, } from "./mesh.js";
//# sourceMappingURL=index.js.map