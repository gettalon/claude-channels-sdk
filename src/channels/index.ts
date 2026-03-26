/**
 * Channel Adapters — Barrel Export
 *
 * Re-exports all channel adapter factory functions and config types.
 */

export { createTelegramChannel, parseConfig as parseTelegramConfig } from "./telegram.js";
export type { TelegramConfig } from "./telegram.js";

export { createDiscordChannel, parseConfig as parseDiscordConfig } from "./discord.js";
export type { DiscordConfig } from "./discord.js";

export { createSlackChannel, parseConfig as parseSlackConfig } from "./slack.js";
export type { SlackConfig } from "./slack.js";

export { createWhatsAppChannel, parseConfig as parseWhatsAppConfig } from "./whatsapp.js";
export type { WhatsAppConfig } from "./whatsapp.js";

export { createMatrixChannel, parseConfig as parseMatrixConfig } from "./matrix.js";
export type { MatrixConfig } from "./matrix.js";

export { createSignalChannel, parseConfig as parseSignalConfig } from "./signal.js";
export type { SignalConfig } from "./signal.js";

export { createIrcChannel, parseConfig as parseIrcConfig } from "./irc.js";
export type { IrcConfig } from "./irc.js";

export { createLineChannel, parseConfig as parseLineConfig } from "./line.js";
export type { LineConfig } from "./line.js";

export { createFeishuChannel, parseConfig as parseFeishuConfig } from "./feishu.js";
export type { FeishuConfig } from "./feishu.js";

export { createTeamsChannel, parseConfig as parseTeamsConfig } from "./msteams.js";
export type { TeamsConfig } from "./msteams.js";
