/**
 * Claude Channels SDK
 *
 * Build Claude Code channels with:
 * - Bidirectional chat (claude/channel)
 * - Permission relay (claude/channel/permission)
 * - All 23 hook events via command hooks + Unix socket IPC
 */
export { ChannelServer } from "./channel-server.js";
export type { HookEventName, HookBaseInput, HookEventInput, HookResponse, PreToolUseResponse, PermissionRequestResponse, SessionStartInput, SessionEndInput, UserPromptSubmitInput, PreToolUseInput, PostToolUseInput, PostToolUseFailureInput, PermissionRequestInput, NotificationInput, SubagentStartInput, SubagentStopInput, StopInput, StopFailureInput, TeammateIdleInput, TaskCompletedInput, InstructionsLoadedInput, ConfigChangeInput, CwdChangedInput, FileChangedInput, WorktreeCreateInput, WorktreeRemoveInput, PreCompactInput, PostCompactInput, ElicitationInput, ElicitationResultInput, ChannelPermissionRequest, ChannelPermissionVerdict, ChannelMessage, HookIpcMessage, HookIpcResponse, IpcInbound, PermissionVerdictMessage, ChatInboundMessage, ChannelServerOptions, HookEventHandler, PermissionRequestHandler, ChatReplyHandler, ToolCallHandler, AccessMode, AccessPolicy, AccessState, PendingPairing, AccessControlOptions, } from "./types.js";
export { BLOCKING_EVENTS } from "./types.js";
export { createUnixTransport, createWebSocketTransport, createStdioTransport } from "./transports/index.js";
export { ChannelHub } from "./hub.js";
export type { AgentState, PendingAgent, HubSettings, HubOptions, HubHookEvent, HubHookFn, ShellCommandHook, UpdateInfo, ContactEntry, ContactChannel } from "./hub.js";
export { createAgentMcpServer, createArchitectServer } from "./architect.js";
export type { AgentMcpOptions, ArchitectOptions } from "./architect.js";
export { loadAgentConfig, saveAgentConfig, listAgentConfigs, deleteAgentConfig } from "./agent-config.js";
export type { AgentConfig } from "./types.js";
export { serialize, deserialize, serializeBuffer, deserializeBuffer, createEnvelope } from "./protocol.js";
export { generateIdentityKeyPair, loadOrCreateIdentity, deriveSharedSecret, E2eSession, SenderKeySession, MeshDiscovery, MeshRegistry, deriveMeshId, generateMeshSecret, createMeshJwt, verifyMeshJwt, deriveEncryptionKey, parseMeshConfig, } from "./mesh.js";
export type { MeshConfig, MeshJwtPayload, EncryptedPayload, DiscoveredPeer, SenderKeyBundle, SenderKeyDistribution, SenderKeyEncryptedMessage, } from "./mesh.js";
//# sourceMappingURL=index.d.ts.map