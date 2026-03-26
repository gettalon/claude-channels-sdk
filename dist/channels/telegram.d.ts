/**
 * Telegram Channel Adapter
 *
 * Uses grammy for bot polling. Features:
 * - Pairing flow: code challenge + /approve for unknown senders
 * - Access control: allowlist, admin users, DM/group policies
 * - Markdown->HTML conversion, message chunking (4096 limit) with ⏬ markers
 * - Inline keyboard permission prompts (Allow/Deny)
 * - Typing indicators while processing
 * - Streaming status: live-updating message showing tool execution
 * - Group chat: mention detection, sender labels
 * - Bot commands: /start, /help, /status, /stop, /new
 * - Message types: text, photo, document, voice, sticker, location, contact, forward, reply-to
 * - File download: photos and documents saved to disk
 * - Rate limiting: per-chat cooldown
 * - Extra tools: telegram_send, telegram_react, telegram_edit, telegram_poll, telegram_download
 * - Persistent access.json storage
 */
import { ChannelServer } from "../channel-server.js";
export type PairingMode = "pairing" | "open" | "disabled";
export interface AccessPolicy {
    policy: PairingMode;
    allowed_users: string[];
    admin_users: string[];
}
export interface TelegramAccess {
    dm: AccessPolicy;
    group: AccessPolicy;
    pending_pairings: Record<string, {
        code: string;
        user_id: string;
        username: string;
        chat_id: string;
        ts: number;
    }>;
}
export interface TelegramConfig {
    botToken: string;
    allowedChats?: string[];
    accessPath?: string;
    downloadPath?: string;
    groupTrigger?: "mention" | "always" | "never";
    streamingUpdates?: boolean;
}
export declare function parseConfig(): TelegramConfig;
export declare function createTelegramChannel(config?: Partial<TelegramConfig>): Promise<{
    channel: ChannelServer;
    cleanup: () => void;
}>;
//# sourceMappingURL=telegram.d.ts.map