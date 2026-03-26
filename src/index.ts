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
} from "./types.js";
export { BLOCKING_EVENTS } from "./types.js";
