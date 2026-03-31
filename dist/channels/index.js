/**
 * Channel Adapters — Barrel Export
 *
 * Re-exports all channel adapter factory functions and config types.
 */
export { createTelegramChannel, parseConfig as parseTelegramConfig } from "./telegram.js";
export { createDiscordChannel, parseConfig as parseDiscordConfig } from "./discord.js";
export { createSlackChannel, parseConfig as parseSlackConfig } from "./slack.js";
export { createWhatsAppChannel, parseConfig as parseWhatsAppConfig } from "./whatsapp.js";
export { createMatrixChannel, parseConfig as parseMatrixConfig } from "./matrix.js";
export { createSignalChannel, parseConfig as parseSignalConfig } from "./signal.js";
export { createIrcChannel, parseConfig as parseIrcConfig } from "./irc.js";
export { createLineChannel, parseConfig as parseLineConfig } from "./line.js";
export { createFeishuChannel, parseConfig as parseFeishuConfig } from "./feishu.js";
export { createTeamsChannel, parseConfig as parseTeamsConfig } from "./msteams.js";
export { createWebSocketChannel, parseConfig as parseWebSocketConfig } from "./websocket.js";
export { createMcpHttpChannel, parseConfig as parseMcpHttpConfig } from "./mcp-http.js";
export { createIMessageChannel, parseConfig as parseIMessageConfig } from "./imessage.js";
//# sourceMappingURL=index.js.map