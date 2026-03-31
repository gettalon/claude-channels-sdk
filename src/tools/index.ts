/**
 * Tool exports — register all tools with a registry.
 */
export { ToolRegistry, text } from "./registry.js";
export type { ToolDefinition, McpTool, ToolContext } from "./types.js";

// Individual tools
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

// Persistent agent tools (from agent-launcher.ts)
export { launchAgentTool, stopAgentTool, listRunningAgentsTool, sendToAgentTool, listApiProvidersTool, agentLogsTool } from "./agent-launcher.js";

import type { ToolRegistry } from "./registry.js";
import { sendTool } from "./send.js";
import { replyTool } from "./reply.js";
import { statusTool } from "./status.js";
import { startServerTool } from "./start-server.js";
import { connectTool } from "./connect.js";
import { discoverTool } from "./discover.js";
import { listAgentsTool } from "./list-agents.js";
import { callToolTool } from "./call-tool.js";
import { sendMessageTool } from "./send-message.js";
import { listChannelsTool } from "./list-channels.js";
import { registerChannelTool } from "./register-channel.js";
import { reloadTool } from "./reload.js";
import { edgeCliTool } from "./edge-cli.js";
import { taskStatusTool } from "./task-status.js";
import { healthTool } from "./health.js";
import { routesTool } from "./routes.js";
import { cleanupVersionsTool } from "./cleanup-versions.js";
import { channelInfoTool } from "./channel-info.js";
import { targetsTool } from "./targets.js";
import { launchAgentTool, stopAgentTool, listRunningAgentsTool, sendToAgentTool, listApiProvidersTool, agentLogsTool } from "./agent-launcher.js";

/**
 * Register all built-in tools with a registry.
 */
export function registerBuiltinTools(registry: ToolRegistry): void {
  // Core messaging (send = universal, reply = chat reply)
  registry.register(sendTool);
  registry.register(replyTool);

  // Server & connection
  registry.register(statusTool);
  registry.register(startServerTool);
  registry.register(connectTool);
  registry.register(listChannelsTool);
  registry.register(registerChannelTool);
  registry.register(reloadTool);
  registry.register(discoverTool);

  // Agent management
  registry.register(launchAgentTool);
  registry.register(stopAgentTool);
  registry.register(listRunningAgentsTool);
  registry.register(listApiProvidersTool);
  registry.register(listAgentsTool);
  registry.register(callToolTool);

  // Observability
  registry.register(agentLogsTool);

  // Task board
  registry.register(taskStatusTool);

  // Monitoring
  registry.register(healthTool);
  registry.register(routesTool);
  registry.register(channelInfoTool);
  registry.register(targetsTool);

  // Maintenance
  registry.register(cleanupVersionsTool);

  // CLI mega-tool
  registry.register(edgeCliTool);
}
