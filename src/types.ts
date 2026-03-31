/**
 * Claude Channels SDK — Types
 *
 * Complete type definitions for Claude Code channels + all 23 hook events.
 * Generic — not tied to any specific client (browser, Telegram, etc.).
 */

// ─── Hook Event Types ────────────────────────────────────────────────────────

/** All 23 Claude Code hook event names */
export type HookEventName =
  | "SessionStart"
  | "SessionEnd"
  | "UserPromptSubmit"
  | "PreToolUse"
  | "PostToolUse"
  | "PostToolUseFailure"
  | "PermissionRequest"
  | "Notification"
  | "SubagentStart"
  | "SubagentStop"
  | "Stop"
  | "StopFailure"
  | "TeammateIdle"
  | "TaskCompleted"
  | "InstructionsLoaded"
  | "ConfigChange"
  | "CwdChanged"
  | "FileChanged"
  | "WorktreeCreate"
  | "WorktreeRemove"
  | "PreCompact"
  | "PostCompact"
  | "Elicitation"
  | "ElicitationResult";

/** Events that can block (exit code 2 or decision:"block") */
export const BLOCKING_EVENTS: ReadonlySet<HookEventName> = new Set([
  "PreToolUse",
  "PermissionRequest",
  "UserPromptSubmit",
  "Stop",
  "SubagentStop",
  "TeammateIdle",
  "TaskCompleted",
  "ConfigChange",
  "Elicitation",
  "ElicitationResult",
  "WorktreeCreate",
]);

// ─── Hook Inputs ─────────────────────────────────────────────────────────────

/** Common fields present in every hook event */
export interface HookBaseInput {
  session_id: string;
  transcript_path?: string;
  cwd: string;
  permission_mode?: string;
  hook_event_name: HookEventName;
  agent_id?: string;
  agent_type?: string;
}

export interface SessionStartInput extends HookBaseInput {
  hook_event_name: "SessionStart";
  source: "startup" | "resume" | "clear" | "compact";
  model: string;
}

export interface SessionEndInput extends HookBaseInput {
  hook_event_name: "SessionEnd";
}

export interface UserPromptSubmitInput extends HookBaseInput {
  hook_event_name: "UserPromptSubmit";
  prompt: string;
}

export interface PreToolUseInput extends HookBaseInput {
  hook_event_name: "PreToolUse";
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_use_id: string;
}

export interface PostToolUseInput extends HookBaseInput {
  hook_event_name: "PostToolUse";
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_response: unknown;
  tool_use_id: string;
}

export interface PostToolUseFailureInput extends HookBaseInput {
  hook_event_name: "PostToolUseFailure";
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_use_id: string;
  error: string;
  is_interrupt: boolean;
}

export interface PermissionRequestInput extends HookBaseInput {
  hook_event_name: "PermissionRequest";
  tool_name: string;
  tool_input: Record<string, unknown>;
  permission_suggestions?: Array<{
    type: string;
    rules?: Array<{ toolName: string; ruleContent: string }>;
    behavior: string;
    destination: string;
  }>;
}

export interface NotificationInput extends HookBaseInput {
  hook_event_name: "Notification";
  message: string;
  title?: string;
  notification_type: "permission_prompt" | "idle_prompt" | "auth_success" | "elicitation_dialog";
}

export interface SubagentStartInput extends HookBaseInput {
  hook_event_name: "SubagentStart";
}

export interface SubagentStopInput extends HookBaseInput {
  hook_event_name: "SubagentStop";
  stop_hook_active: boolean;
  agent_transcript_path?: string;
  last_assistant_message?: string;
}

export interface StopInput extends HookBaseInput {
  hook_event_name: "Stop";
  stop_hook_active: boolean;
  last_assistant_message?: string;
}

export interface StopFailureInput extends HookBaseInput {
  hook_event_name: "StopFailure";
  error: string;
  error_details?: string;
  last_assistant_message?: string;
}

export interface TeammateIdleInput extends HookBaseInput {
  hook_event_name: "TeammateIdle";
  teammate_name: string;
  team_name: string;
}

export interface TaskCompletedInput extends HookBaseInput {
  hook_event_name: "TaskCompleted";
  task_id: string;
  task_subject: string;
  task_description?: string;
  teammate_name?: string;
  team_name?: string;
}

export interface InstructionsLoadedInput extends HookBaseInput {
  hook_event_name: "InstructionsLoaded";
  file_path: string;
  memory_type: "User" | "Project" | "Local" | "Managed";
  load_reason: string;
}

export interface ConfigChangeInput extends HookBaseInput {
  hook_event_name: "ConfigChange";
  source: string;
  file_path: string;
}

export interface CwdChangedInput extends HookBaseInput {
  hook_event_name: "CwdChanged";
  old_cwd: string;
  new_cwd: string;
}

export interface FileChangedInput extends HookBaseInput {
  hook_event_name: "FileChanged";
  file_path: string;
  event: "change" | "add" | "unlink";
}

export interface WorktreeCreateInput extends HookBaseInput {
  hook_event_name: "WorktreeCreate";
  name: string;
}

export interface WorktreeRemoveInput extends HookBaseInput {
  hook_event_name: "WorktreeRemove";
}

export interface PreCompactInput extends HookBaseInput {
  hook_event_name: "PreCompact";
}

export interface PostCompactInput extends HookBaseInput {
  hook_event_name: "PostCompact";
}

export interface ElicitationInput extends HookBaseInput {
  hook_event_name: "Elicitation";
  tool_name: string;
  mcp_server_name: string;
  form_schema: Record<string, unknown>;
}

export interface ElicitationResultInput extends HookBaseInput {
  hook_event_name: "ElicitationResult";
  mcp_server_name: string;
  form_values: Record<string, unknown>;
}

/** Union of all hook event inputs */
export type HookEventInput =
  | SessionStartInput
  | SessionEndInput
  | UserPromptSubmitInput
  | PreToolUseInput
  | PostToolUseInput
  | PostToolUseFailureInput
  | PermissionRequestInput
  | NotificationInput
  | SubagentStartInput
  | SubagentStopInput
  | StopInput
  | StopFailureInput
  | TeammateIdleInput
  | TaskCompletedInput
  | InstructionsLoadedInput
  | ConfigChangeInput
  | CwdChangedInput
  | FileChangedInput
  | WorktreeCreateInput
  | WorktreeRemoveInput
  | PreCompactInput
  | PostCompactInput
  | ElicitationInput
  | ElicitationResultInput;

// ─── Hook Responses ──────────────────────────────────────────────────────────

/** Response returned by hook handler — written to stdout as JSON */
export interface HookResponse {
  continue?: boolean;
  stopReason?: string;
  suppressOutput?: boolean;
  systemMessage?: string;
  hookSpecificOutput?: Record<string, unknown>;
}

export interface PreToolUseResponse extends HookResponse {
  hookSpecificOutput?: {
    hookEventName: "PreToolUse";
    permissionDecision?: "allow" | "deny" | "ask";
    permissionDecisionReason?: string;
    updatedInput?: Record<string, unknown>;
    additionalContext?: string;
  };
}

export interface PermissionRequestResponse extends HookResponse {
  hookSpecificOutput?: {
    hookEventName: "PermissionRequest";
    decision?: {
      behavior: "allow" | "deny";
      updatedInput?: Record<string, unknown>;
      message?: string;
    };
  };
}

// ─── Channel Permission Relay (MCP protocol) ────────────────────────────────

/** Permission request forwarded by Claude Code via MCP notification */
export interface ChannelPermissionRequest {
  request_id: string;
  tool_name: string;
  description: string;
  input_preview: string;
}

/** Verdict sent back to Claude Code via MCP notification */
export interface ChannelPermissionVerdict {
  request_id: string;
  behavior: "allow" | "deny";
}

// ─── Channel Messages ───────────────────────────────────────────────────────

/** Inbound message pushed to Claude via channel */
export interface ChannelMessage {
  content: string;
  meta?: Record<string, string>;
}

// ─── IPC Protocol (Unix socket between hook scripts <-> ChannelServer) ──────

/** Message sent from hook script to ChannelServer via Unix socket */
export interface HookIpcMessage {
  type: "hook_event";
  id: string;
  input: HookEventInput;
  /** If true, script waits for a response before exiting */
  blocking: boolean;
}

/** Response from ChannelServer back to hook script */
export interface HookIpcResponse {
  id: string;
  response: HookResponse;
}

/** Permission verdict from client, forwarded through ChannelServer */
export interface PermissionVerdictMessage {
  type: "permission_verdict";
  request_id: string;
  behavior: "allow" | "deny";
}

/** Chat message from client, forwarded through ChannelServer to Claude */
export interface ChatInboundMessage {
  type: "chat_message";
  chat_id: string;
  content: string;
  meta?: Record<string, string>;
}

/** Union of all IPC messages the ChannelServer can receive */
export type IpcInbound = HookIpcMessage | PermissionVerdictMessage | ChatInboundMessage;

// ─── SDK Options ─────────────────────────────────────────────────────────────

export interface ChannelServerOptions {
  /** MCP server name (e.g. "my-channel") */
  name: string;
  version: string;
  /** Instructions injected into Claude's system prompt */
  instructions: string;
  /** Agent display name (e.g. "Arc", "Home Claude"). Injected into meta as agent_name. */
  agentName?: string;
  /** Enable permission relay capability (default: true) */
  permissionRelay?: boolean;
  /** Unix socket path for hook IPC (default: ~/.claude/channel-hooks.sock) */
  socketPath?: string;
  /** Additional MCP tools besides the built-in reply tool */
  extraTools?: Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  }>;
  /** Which hook events to accept (default: all) */
  enabledHooks?: HookEventName[];
  /** Timeout in ms for blocking hook client responses (default: 30000) */
  blockingTimeout?: number;
  /** Access control / pairing options */
  accessControl?: AccessControlOptions;
}

// ─── Event Callbacks ─────────────────────────────────────────────────────────

export type HookEventHandler = (input: HookEventInput) => HookResponse | Promise<HookResponse | void> | void;
export type PermissionRequestHandler = (request: ChannelPermissionRequest) => void;
export type ChatReplyHandler = (chatId: string, text: string) => void;
export type ToolCallHandler = (name: string, args: Record<string, unknown>) => Promise<unknown>;

// ─── Access Control & Pairing ───────────────────────────────────────────────

/** Access policy mode for a channel */
export type AccessMode = "pairing" | "open" | "disabled";

/** Per-scope access policy */
export interface AccessPolicy {
  mode: AccessMode;
  allowed: string[];   // user/agent IDs that are approved
  admins: string[];    // IDs with admin privileges (can approve others)
}

/** Pending pairing request */
export interface PendingPairing {
  code: string;
  identity: string;      // user ID, agent name, or connection ID
  displayName: string;   // human-readable name
  chatId: string;        // where to send approval notifications
  channel: string;       // which channel adapter ("telegram", "websocket", "mcp-http", etc.)
  ts: number;            // timestamp
  metadata?: Record<string, unknown>;
}

/** Persisted access state */
export interface AccessState {
  default: AccessPolicy;
  pending: Record<string, PendingPairing>; // keyed by pairing ID
}

/** Options for access control */
export interface AccessControlOptions {
  /** Path to persist access.json (default: ~/.claude/channels/access.json) */
  accessPath?: string;
  /** Default access mode (default: "pairing") */
  defaultMode?: AccessMode;
  /** Auto-approve first connection as admin (default: true) */
  autoApproveFirst?: boolean;
  /** Pairing code length (default: 6) */
  codeLength?: number;
}

// ─── Per-Agent Config ─────────────────────────────────────────────────────────

/** Per-agent configuration stored in ~/.talon/agents/{id}.json */
export interface AgentConfig {
  id: string;
  name: string;
  channels?: Array<{ type: string; id: string; url: string }>;
  access?: {
    allowlist?: string[];
    denylist?: string[];
    requireApproval?: boolean;
  };
  state?: {
    chatRoutes?: Record<string, { agentName: string; channel?: string; channelUrl?: string }>;
    groups?: Record<string, string[]>;
  };
  contacts?: Record<string, { name: string; channels: Array<{ type: string; id: string; url: string }> }>;
  handover?: Record<string, unknown>;
  /** Channel types this agent is allowed to use. Empty/undefined = all allowed. */
  allowedChannels?: string[];
  /** Agent names/IDs this agent is allowed to communicate with. Empty/undefined = all allowed. */
  allowedAgents?: string[];
  /** Keywords/intents this agent can handle, used for content-based routing. */
  intents?: string[];
  /** Group permissions: which groups this agent belongs to and its role in each. */
  groupPermissions?: Record<string, { role: "member" | "admin" | "owner"; canSend?: boolean; canReceive?: boolean }>;
  metadata?: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
}
