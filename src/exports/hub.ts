/**
 * Subpath entry: @gettalon/channels-sdk/hub
 *
 * ChannelHub core, state management, facade, and commands.
 */

// Core hub class
export { ChannelHub, randomAgentName, ensureMachineId, setSettingsPath } from "../hub.js";

// Hub types
export type {
  AgentState,
  PendingAgent,
  HubSettings,
  HubOptions,
  HubHookEvent,
  HubHookFn,
  ShellCommandHook,
  UpdateInfo,
  ContactEntry,
  ContactChannel,
  GroupMember,
  TargetEntry,
  HealthSnapshot,
  ClientEntry,
} from "../hub.js";

// Hub facade
export type {
  HubFacade,
  AgentSummary,
  PendingAgentSummary,
  TargetSummary,
  ServerSummary,
  ContactSummary,
} from "../hub-facade.js";

// Hub state
export { HubState } from "../hub-state.js";
export type { BufferedMessage } from "../hub-state.js";

// Hub commands
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
} from "../hub-commands.js";

export type {
  CommandResult,
  CommandHandler,
  CommandDef,
  TalonSettings,
} from "../hub-commands.js";
