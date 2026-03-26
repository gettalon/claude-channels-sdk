/**
 * Telegram Channel Adapter
 *
 * Uses grammy for bot polling. Supports markdown->HTML conversion,
 * message chunking (4096 limit), inline keyboard permission prompts,
 * and extra tools: telegram_send, telegram_react, telegram_edit, telegram_poll.
 */
import { ChannelServer } from "../channel-server.js";
export interface TelegramConfig {
    botToken: string;
    allowedChats?: string[];
}
export declare function parseConfig(): TelegramConfig;
export declare function createTelegramChannel(config?: Partial<TelegramConfig>): Promise<{
    channel: ChannelServer;
    cleanup: () => void;
}>;
//# sourceMappingURL=telegram.d.ts.map