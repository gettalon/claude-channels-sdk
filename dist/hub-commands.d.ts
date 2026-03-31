import type { ChannelHub } from "./hub.js";
/** Result of executing a hub command. */
export interface CommandResult {
    /** Text response to send back to the caller. */
    text: string;
    /** Optional format hint for the channel. */
    format?: "text" | "html" | "markdown";
}
/** Handler for a registered hub command. */
export type CommandHandler = (hub: ChannelHub, arg: string, context: {
    chatId?: string;
    user?: string;
}) => CommandResult | Promise<CommandResult>;
/** Registered command definition. */
export interface CommandDef {
    name: string;
    description: string;
    handler: CommandHandler;
}
export interface TalonSettings {
    hooksVisible?: boolean;
    [key: string]: unknown;
}
export declare function loadTalonSettings(): Promise<TalonSettings>;
export declare function saveTalonSettings(settings: TalonSettings): Promise<void>;
/** Check if hooks should be displayed (default: true). */
export declare function areHooksVisible(): Promise<boolean>;
/** Set hooks visibility. */
export declare function setHooksVisible(visible: boolean): Promise<void>;
/** Register a command. Overwrites existing commands with the same name. */
export declare function registerCommand(def: CommandDef): void;
/** Unregister a command. */
export declare function unregisterCommand(name: string): boolean;
/** Get a registered command by name. */
export declare function getCommand(name: string): CommandDef | undefined;
/** List all registered commands. */
export declare function listCommands(): CommandDef[];
/** Parse a command string (e.g. "/hooks on") → { name, arg }. */
export declare function parseHubCommand(text: string): {
    name: string;
    arg: string;
} | null;
/**
 * Execute a hub command by text string.
 * Returns null if the command is not recognized.
 */
export declare function executeCommand(hub: ChannelHub, text: string, context?: {
    chatId?: string;
    user?: string;
}): Promise<CommandResult | null>;
export declare function installCommands(Hub: typeof ChannelHub): void;
//# sourceMappingURL=hub-commands.d.ts.map