/**
 * Telegram Transport — edge agent protocol over Telegram Bot API
 *
 * Uses Telegram as a relay. Agents behind firewalls can communicate
 * without direct IP or port forwarding. Messages are JSON-encoded
 * protocol messages sent as Telegram text messages.
 *
 * Server mode: bot receives messages from agents via webhook/polling
 * Client mode: agent sends messages to a bot/chat
 *
 * Supported Telegram message types:
 * - Receiving: text, voice, audio, photo, document, video, sticker,
 *   video_note, animation, location, venue, contact, poll, dice,
 *   edited_message, callback_query, reply_to_message, forward_from
 * - Sending: sendMessage, sendDocument, sendPhoto, sendVoice, sendAudio,
 *   sendVideo, sendAnimation, sendVideoNote, sendSticker, sendLocation,
 *   sendVenue, sendContact, sendPoll, sendMediaGroup, editMessageText,
 *   deleteMessage, answerCallbackQuery
 */
import type { Transport, TransportAdapter, ConnectionHandler, MessageHandler } from "../protocol.js";
export declare class TelegramAdapter implements TransportAdapter {
    readonly type = "telegram";
    private token;
    private polling;
    private pollGeneration;
    private transports;
    private connectionHandler;
    private lastUpdateId;
    private sendOnly;
    private fallbackHandler;
    /** Cohere API key for voice transcription (STT) */
    private cohereApiKey;
    private webhookUrl;
    private webhookPort;
    private webhookPath;
    private webhookServer;
    private webhookRegistered;
    constructor(config?: Record<string, unknown>);
    /** Whether webhook mode is enabled */
    private get useWebhook();
    /** Route a raw Telegram update to the appropriate transport */
    private dispatchUpdate;
    /** Get or create a transport for a chatId */
    private getOrCreateTransport;
    /** Handle voice/audio messages: download from Telegram, transcribe via Cohere, dispatch as text */
    private handleVoiceMessage;
    /** Handle photo/document/video/sticker/video_note/animation messages: download file, forward as chat with attachment. */
    private handleFileMessage;
    /** Single poll iteration */
    private poll;
    /** Start the shared poller (idempotent). Uses generation counter to invalidate old loops on reconnect. */
    private startPolling;
    /** Start the webhook HTTP server and register the URL with Telegram (idempotent). */
    private startWebhook;
    /** Start receiving updates via the configured mode (idempotent). */
    private startReceiving;
    /** Server mode: receive messages from agents via webhook or polling */
    listen(_port: number, handler: ConnectionHandler): Promise<void>;
    /** Client mode: connect to a specific chat */
    /** Bot username fetched via getMe on first connect */
    botUsername: string | undefined;
    connect(url: string, handler: MessageHandler): Promise<Transport>;
    /** Get the display name for this adapter (bot username or "telegram") */
    get displayName(): string;
    close(): Promise<void>;
}
/** Create a Telegram transport adapter */
export declare function createTelegramTransport(config?: Record<string, unknown>): TransportAdapter;
//# sourceMappingURL=telegram.d.ts.map