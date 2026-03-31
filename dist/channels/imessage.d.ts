/**
 * iMessage Channel Adapter
 *
 * Uses AppleScript to send messages via Messages.app and polls
 * ~/Library/Messages/chat.db (SQLite) for incoming messages.
 *
 * Features:
 * - AppleScript bridge for sending via `osascript`
 * - SQLite polling of chat.db for new inbound messages
 * - Support for both phone numbers and email addresses as recipients
 * - Config: pollInterval, allowedContacts whitelist
 * - macOS platform check (throws clear error on non-macOS)
 * - Proper escaping for AppleScript strings
 * - Graceful fallback when SIP blocks chat.db access
 * - Extra tools: imessage_send, imessage_contacts, imessage_history
 */
import { ChannelServer } from "../channel-server.js";
export interface IMessageConfig {
    /** Poll interval in ms for checking new messages (default: 5000) */
    pollInterval?: number;
    /** Optional whitelist of allowed contacts (phone numbers or emails). Empty = all allowed. */
    allowedContacts?: string[];
    /** Path to Messages chat.db (default: ~/Library/Messages/chat.db) */
    chatDbPath?: string;
}
export declare function parseConfig(): IMessageConfig;
export declare function createIMessageChannel(config?: Partial<IMessageConfig>): Promise<{
    channel: ChannelServer;
    cleanup: () => void;
}>;
//# sourceMappingURL=imessage.d.ts.map