#!/usr/bin/env node
/**
 * Claude Channels SDK — Setup Script
 *
 * Interactive setup that configures Claude Code settings:
 * - Adds your channel as an MCP server
 * - Installs hook commands for selected events (with full path resolution)
 * - Configures channel type and credentials (env vars in settings.json)
 * - Auto-detects claude-hook binary path
 *
 * Usage:
 *   npx @gettalon/channels-sdk setup
 *   npx @gettalon/channels-sdk setup --name my-channel --entry ./my-server.js
 *   npx @gettalon/channels-sdk setup --channel telegram --token YOUR_BOT_TOKEN
 *   npx @gettalon/channels-sdk setup --preset all
 *   npx @gettalon/channels-sdk setup --hooks PreToolUse,PostToolUse,Notification
 */
export {};
//# sourceMappingURL=setup.d.ts.map