/**
 * Claude Channels SDK
 *
 * Build Claude Code channels with:
 * - Bidirectional chat (claude/channel)
 * - Permission relay (claude/channel/permission)
 * - All 23 hook events via command hooks + Unix socket IPC
 */

export { ChannelServer } from "./channel-server.js";
export type {
  // Hook events
  HookEventName,
  HookBaseInput,
  HookEventInput,
  HookResponse,
  PreToolUseResponse,
  PermissionRequestResponse,
  // Individual event inputs
  SessionStartInput,
  SessionEndInput,
  UserPromptSubmitInput,
  PreToolUseInput,
  PostToolUseInput,
  PostToolUseFailureInput,
  PermissionRequestInput,
  NotificationInput,
  SubagentStartInput,
  SubagentStopInput,
  StopInput,
  StopFailureInput,
  TeammateIdleInput,
  TaskCompletedInput,
  InstructionsLoadedInput,
  ConfigChangeInput,
  CwdChangedInput,
  FileChangedInput,
  WorktreeCreateInput,
  WorktreeRemoveInput,
  PreCompactInput,
  PostCompactInput,
  ElicitationInput,
  ElicitationResultInput,
  // Channel types
  ChannelPermissionRequest,
  ChannelPermissionVerdict,
  ChannelMessage,
  // IPC types
  HookIpcMessage,
  HookIpcResponse,
  IpcInbound,
  PermissionVerdictMessage,
  ChatInboundMessage,
  // Options & handlers
  ChannelServerOptions,
  HookEventHandler,
  PermissionRequestHandler,
  ChatReplyHandler,
  ToolCallHandler,
  // Access control
  AccessMode,
  AccessPolicy,
  AccessState,
  PendingPairing,
  AccessControlOptions,
} from "./types.js";
export { BLOCKING_EVENTS } from "./types.js";

// Protocol (transport-agnostic)
export { MessageType, serialize, deserialize, serializeBuffer, deserializeBuffer, createEnvelope } from "./protocol.js";
export type {
  ProtocolMessage,
  RegisterMessage,
  RegisterAckMessage,
  HeartbeatMessage,
  HeartbeatAckMessage,
  ToolCallMessage,
  ToolResultMessage,
  ChatMessage,
  ReplyMessage,
  PermissionRequestMessage as ProtocolPermissionRequest,
  PermissionVerdictMessage as ProtocolPermissionVerdict,
  FileTransferMessage,
  GroupBroadcastMessage,
  GroupInfoMessage,
  InviteMessage,
  StreamStartMessage,
  StreamChunkMessage,
  StreamEndMessage,
  AgentToolDef,
  ConnectedAgent,
  Transport,
  TransportAdapter,
  ConnectionHandler,
  MessageHandler,
  SessionEnvelope,
  RecipientFilter,
  RichMessageParams,
} from "./protocol.js";

// Built-in transports (auto-registered: unix, websocket, stdio, telegram)
export { UnixSocketAdapter, createUnixTransport, WebSocketAdapter, createWebSocketTransport, TelegramAdapter, createTelegramTransport, StdioAdapter, StdioTransport, createStdioTransport } from "./transports/index.js";

// Application-level channel adapters as transports (auto-registered: discord, slack, whatsapp, matrix, signal, irc, line, feishu, msteams)
export {
  createDiscordTransport,
  createSlackTransport,
  createWhatsAppTransport,
  createMatrixTransport,
  createSignalTransport,
  createIrcTransport,
  createLineTransport,
  createFeishuTransport,
  createMsTeamsTransport,
} from "./transports/index.js";

// Channel Hub (SDK-level connection manager)
export { ChannelHub } from "./hub.js";
export type { AgentState, PendingAgent, HubSettings, HubOptions, HubHookEvent, HubHookFn, ShellCommandHook, UpdateInfo, ContactEntry, ContactChannel } from "./hub.js";

// Hub commands (command registry + built-in /hooks, /status, /agents)
export {
  registerCommand,
  unregisterCommand,
  getCommand,
  listCommands,
  parseHubCommand,
  executeCommand,
  areHooksVisible,
  setHooksVisible,
  loadTalonSettings,
  saveTalonSettings,
} from "./hub-commands.js";
export type { CommandResult, CommandHandler, CommandDef, TalonSettings } from "./hub-commands.js";

// Architect (MCP wrapper around ChannelHub)
export { createArchitectServer, createAgentMcpServer } from "./architect.js";
export type { ArchitectOptions, AgentMcpOptions } from "./architect.js";

// Daemon mode (run ChannelHub as background process)
export { daemonStart, daemonStop, daemonRestart, daemonStatus } from "./daemon.js";
export type { DaemonStatus, DaemonStartResult } from "./daemon.js";

// Persistent agent launcher
export { launchAgent, stopAgent, sendToAgent, listRunningAgents, getAgent, getAgentStatus, agentFolder, AsyncQueue } from "./tools/agent-launcher.js";
export type { PersistentAgent, LaunchAgentOptions } from "./tools/agent-launcher.js";

// Per-agent config
export { loadAgentConfig, saveAgentConfig, listAgentConfigs, deleteAgentConfig, migrateSettingsToPerAgent } from "./agent-config.js";
export type { AgentConfig } from "./types.js";

// Mesh networking
export {
  deriveMeshId,
  generateMeshSecret,
  generateIdentityKeyPair,
  loadOrCreateIdentity,
  deriveSharedSecret,
  createMeshJwt,
  verifyMeshJwt,
  deriveEncryptionKey,
  E2eSession,
  SenderKeySession,
  MeshDiscovery,
  MeshRegistry,
  parseMeshConfig,
} from "./mesh.js";
export type {
  MeshConfig,
  MeshJwtPayload,
  EncryptedPayload,
  DiscoveredPeer,
  SenderKeyBundle,
  SenderKeyDistribution,
  SenderKeyEncryptedMessage,
} from "./mesh.js";
