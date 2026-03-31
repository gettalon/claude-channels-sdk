/**
 * Subpath entry: @gettalon/channels-sdk/hub
 *
 * ChannelHub core, state management, facade, and commands.
 */
export { ChannelHub, randomAgentName, ensureMachineId, setSettingsPath } from "../hub.js";
export type { AgentState, PendingAgent, HubSettings, HubOptions, HubHookEvent, HubHookFn, ShellCommandHook, UpdateInfo, ContactEntry, ContactChannel, GroupMember, TargetEntry, HealthSnapshot, ClientEntry, } from "../hub.js";
export type { HubFacade, AgentSummary, PendingAgentSummary, TargetSummary, ServerSummary, ContactSummary, } from "../hub-facade.js";
export { HubState } from "../hub-state.js";
export type { BufferedMessage } from "../hub-state.js";
export { registerCommand, unregisterCommand, getCommand, listCommands, parseHubCommand, executeCommand, areHooksVisible, setHooksVisible, loadTalonSettings, saveTalonSettings, } from "../hub-commands.js";
export type { CommandResult, CommandHandler, CommandDef, TalonSettings, } from "../hub-commands.js";
//# sourceMappingURL=hub.d.ts.map