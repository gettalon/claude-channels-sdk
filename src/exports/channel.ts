/**
 * Subpath entry: @gettalon/channels-sdk/channel
 *
 * Channel server runtime, IPC types, hook events, and access control.
 */

// Channel server
export { ChannelServer } from "../channel-server.js";

// All types from types.ts
export { BLOCKING_EVENTS } from "../types.js";

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
  // Agent config
  AgentConfig,
} from "../types.js";

// Per-agent config management
export {
  loadAgentConfig,
  saveAgentConfig,
  listAgentConfigs,
  deleteAgentConfig,
  migrateSettingsToPerAgent,
} from "../agent-config.js";
