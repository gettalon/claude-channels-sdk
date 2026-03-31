import type { Query, SDKUserMessage, McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
/**
 * A simple async queue that implements AsyncIterable<T>.
 * Items pushed into the queue are yielded to the async iterator.
 * Calling close() signals the end of the stream.
 */
export declare class AsyncQueue<T> {
    private queue;
    private resolve?;
    private closed;
    push(item: T): void;
    close(): void;
    get isClosed(): boolean;
    get length(): number;
    [Symbol.asyncIterator](): AsyncGenerator<T>;
}
export interface ApiProviderConfig {
    baseUrl: string;
    authToken?: string;
    model?: string;
    smallModel?: string;
}
/**
 * Store an API key in the best available backend.
 * macOS: Keychain. Others: ~/.talon/settings.json
 */
export declare function storeApiKey(provider: string, key: string): {
    stored: string;
};
/** Cached providers — reloaded each launch to pick up settings changes. */
export declare let API_PROVIDERS: Record<string, ApiProviderConfig>;
/** Callback invoked when a persistent agent produces output text. */
export type AgentOutputCallback = (agentName: string, text: string, chatId?: string) => void;
export interface PersistentAgent {
    name: string;
    folder: string;
    pid?: number;
    status: "running" | "stopped" | "error";
    mode: "master" | "bypass" | "direct";
    botToken?: string;
    hubUrl?: string;
    startedAt?: string;
    /** The running Query instance (in-memory only, not serialized) */
    query?: Query;
    /** Push a message to the agent's input queue */
    sendMessage?: (text: string, from?: string, chatId?: string) => void;
    /** Last chat ID that sent a message to this agent — used for reply routing */
    lastChatId?: string;
    /** Callback for agent output */
    onOutput?: AgentOutputCallback;
    /** Why the agent exited: "completed" or "error: <message>" */
    exitReason?: string;
    /** Ring buffer of recent output log entries (max MAX_AGENT_LOGS) */
    logs?: string[];
}
export interface LaunchAgentOptions {
    mode?: "master" | "bypass" | "direct";
    prompt?: string;
    botToken?: string;
    hubUrl?: string;
    mcpServers?: Record<string, McpServerConfig>;
    /** Called when the agent produces output text — wire this to route replies back to channels */
    onOutput?: AgentOutputCallback;
    /** Working directory for the agent (defaults to agent folder) */
    cwd?: string;
    /** Additional directories the agent can access */
    additionalDirectories?: string[];
    /** API provider preset name (e.g. "glm", "anthropic", "deepseek", "ark", "openrouter") */
    apiProvider?: string;
    /** Custom API base URL (overrides provider preset) */
    apiBaseUrl?: string;
    /** API auth token/key (overrides provider preset or inherits from environment) */
    apiToken?: string;
    /** AI model name (overrides provider preset) */
    model?: string;
    /** Small/fast model for non-critical tasks */
    smallModel?: string;
    /** Fallback model if primary unavailable */
    fallbackModel?: string;
    /** Tools auto-allowed without approval */
    allowedTools?: string[];
    /** Tools blocked from use */
    disallowedTools?: string[];
    /** Base toolset — array of tool names, or empty [] to disable all */
    tools?: string[];
    /** Agent definition name to use */
    agent?: string;
    /** Sub-agent definitions available to this agent */
    agents?: Record<string, {
        description: string;
        prompt: string;
        tools?: string[];
    }>;
    /** Hooks callbacks */
    hooks?: boolean;
    /** Save session to disk */
    persistSession?: boolean;
    /** Enable file checkpointing for rewind */
    enableFileCheckpointing?: boolean;
    /** Path to agent.smith.md template (overrides default CLAUDE.md) */
    template?: string;
    /** Replace the default system prompt entirely */
    systemPrompt?: string;
    /** Append to the default system prompt (identity prompt goes here by default) */
    appendSystemPrompt?: string;
    /** Permission mode: bypassPermissions (default), default, plan */
    permissionMode?: string;
}
export declare function agentFolder(name: string): string;
/** Remove old cached versions, keeping only the latest one. */
export declare function cleanupStaleVersions(): {
    removed: string[];
    kept: string;
};
type QueryFactory = (params: {
    prompt: string | AsyncIterable<SDKUserMessage>;
    options?: Record<string, any>;
}) => Query;
/** Override the query factory (for testing). */
export declare function _setQueryFactory(fn: QueryFactory): void;
/** Reset the query factory to use the real SDK. */
export declare function _resetQueryFactory(): void;
export declare function launchAgent(name: string, opts?: LaunchAgentOptions): Promise<PersistentAgent>;
export declare function sendToAgent(name: string, text: string, from?: string, chatId?: string): {
    sent: boolean;
    buffered?: boolean;
    error?: string;
};
export declare function stopAgent(name: string): Promise<{
    stopped: boolean;
    error?: string;
}>;
export declare function listRunningAgents(): Promise<PersistentAgent[]>;
export declare function getAgent(name: string): PersistentAgent | undefined;
export declare function getAgentStatus(name: string): Promise<PersistentAgent>;
/** Clear all running agents from memory (for testing). */
export declare function _clearRunningAgents(): void;
import type { ToolDefinition } from "./types.js";
export declare const launchAgentTool: ToolDefinition;
export declare const stopAgentTool: ToolDefinition;
export declare const listRunningAgentsTool: ToolDefinition;
export declare const sendToAgentTool: ToolDefinition;
export declare function getAgentLogs(name: string): {
    logs: string[];
    exitReason?: string;
    error?: string;
};
export declare const agentLogsTool: ToolDefinition;
export declare const listApiProvidersTool: ToolDefinition;
export {};
//# sourceMappingURL=agent-launcher.d.ts.map