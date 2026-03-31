/**
 * Tool exports — register all tools with a registry.
 */
export { ToolRegistry, text } from "./registry.js";
export type { ToolDefinition, McpTool, ToolContext } from "./types.js";
export { sendTool } from "./send.js";
export { replyTool } from "./reply.js";
export { statusTool } from "./status.js";
export { startServerTool } from "./start-server.js";
export { connectTool } from "./connect.js";
export { discoverTool } from "./discover.js";
export { listAgentsTool } from "./list-agents.js";
export { callToolTool } from "./call-tool.js";
export { sendMessageTool } from "./send-message.js";
export { listChannelsTool } from "./list-channels.js";
export { registerChannelTool } from "./register-channel.js";
export { reloadTool } from "./reload.js";
export { edgeCliTool } from "./edge-cli.js";
export { taskStatusTool } from "./task-status.js";
export { healthTool } from "./health.js";
export { routesTool } from "./routes.js";
export { cleanupVersionsTool } from "./cleanup-versions.js";
export { channelInfoTool } from "./channel-info.js";
export { targetsTool } from "./targets.js";
export { launchAgentTool, stopAgentTool, listRunningAgentsTool, sendToAgentTool, listApiProvidersTool, agentLogsTool } from "./agent-launcher.js";
import type { ToolRegistry } from "./registry.js";
/**
 * Register all built-in tools with a registry.
 */
export declare function registerBuiltinTools(registry: ToolRegistry): void;
//# sourceMappingURL=index.d.ts.map