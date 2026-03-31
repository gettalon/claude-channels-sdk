/**
 * Telegram Channel Adapter
 *
 * Uses direct Telegram Bot API HTTP calls with a local webhook server.
 * Features:
 * - No grammy dependency or framework abstraction
 * - Webhook mode with optional automatic setWebhook/deleteWebhook
 * - Pairing flow: code challenge + /approve for unknown senders
 * - Access control: allowlist, admin users, DM/group policies
 * - Markdown->HTML conversion, message chunking (4096 limit) with continuation markers
 * - Inline keyboard permission prompts (Allow/Deny)
 * - Typing indicators while processing
 * - Streaming status: live-updating message showing tool execution
 * - Bot commands: /start, /help, /status, /stop, /new, /streaming
 * - Message types: text, photo, document, voice, sticker, animation, location, contact
 * - File download: photos/documents/voice saved to disk
 * - Voice transcription: Groq Whisper API with local whisper CLI fallback
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
    /** Map of user ID → role label (e.g. "938185675": "owner") */
    user_roles?: Record<string, string>;
}
export interface TelegramConfig {
    botToken: string;
    allowedChats?: string[];
    accessPath?: string;
    downloadPath?: string;
    groupTrigger?: "mention" | "always" | "never";
    streamingUpdates?: boolean;
    webhookPort?: number;
    webhookHost?: string;
    webhookPath?: string;
    webhookUrl?: string;
    webhookSecret?: string;
    groqApiKey?: string;
    whisperModel?: string;
    /** Map of user ID → role label (e.g. { "938185675": "owner" }) */
    userRoles?: Record<string, string>;
}
export declare function parseConfig(): TelegramConfig;
export declare function createTelegramChannel(config?: Partial<TelegramConfig>): Promise<{
    channel: ChannelServer;
    cleanup: () => void;
}>;
//# sourceMappingURL=telegram.d.ts.map