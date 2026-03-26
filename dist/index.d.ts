/**
 * Claude Channels SDK
 *
 * Build Claude Code channels with:
 * - Bidirectional chat (claude/channel)
 * - Permission relay (claude/channel/permission)
 * - All 23 hook events via command hooks + Unix socket IPC
 */
export { ChannelServer } from "./channel-server.js";
export type { HookEventName, HookBaseInput, HookEventInput, HookResponse, PreToolUseResponse, PermissionRequestResponse, SessionStartInput, SessionEndInput, UserPromptSubmitInput, PreToolUseInput, PostToolUseInput, PostToolUseFailureInput, PermissionRequestInput, NotificationInput, SubagentStartInput, SubagentStopInput, StopInput, StopFailureInput, TeammateIdleInput, TaskCompletedInput, InstructionsLoadedInput, ConfigChangeInput, CwdChangedInput, FileChangedInput, WorktreeCreateInput, WorktreeRemoveInput, PreCompactInput, PostCompactInput, ElicitationInput, ElicitationResultInput, ChannelPermissionRequest, ChannelPermissionVerdict, ChannelMessage, HookIpcMessage, HookIpcResponse, IpcInbound, PermissionVerdictMessage, ChatInboundMessage, ChannelServerOptions, HookEventHandler, PermissionRequestHandler, ChatReplyHandler, ToolCallHandler, } from "./types.js";
export { BLOCKING_EVENTS } from "./types.js";
//# sourceMappingURL=index.d.ts.map