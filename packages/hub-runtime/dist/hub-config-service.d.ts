/**
 * hub-config-service.ts — Centralised configuration for ChannelHub.
 *
 * Reads every environment variable exactly once, merges with config-file
 * values and programmatic options, and exposes a typed config object.
 *
 * Precedence (highest → lowest):
 *   code options  >  config file  >  environment  >  defaults
 */
export interface TalonConfig {
    /** Hub / agent display name. */
    agentName: string;
    /** Default server port. */
    port: number;
    /** Dev-mode flag (enables file watcher, auto-sync). */
    devMode: boolean;
    /** Resolved TALON_HOME directory. */
    talonHome: string;
    /** Telegram bot token (optional). */
    telegramBotToken?: string;
    /** Network security settings. */
    network: {
        /** Bind address for HTTP+WS. Defaults to "127.0.0.1". */
        bindHost: string;
        /** Allowed CORS origins. Empty = localhost only. */
        corsOrigins?: string[];
        /** Bearer token required for POST/DELETE endpoints. */
        authToken?: string;
    };
}
/**
 * Singleton-style config service.
 *
 * Create via `HubConfigService.create()` (async, reads settings file) or
 * `new HubConfigService(env)` (sync, env-only — no settings file merge).
 */
export declare class HubConfigService {
    /** Cached env snapshot — avoids repeated process.env reads. */
    private readonly env;
    /** Merged settings from config file (may be empty). */
    private readonly fileSettings;
    private constructor();
    /** Create a config service with settings file merged in. */
    static create(): Promise<HubConfigService>;
    /** Create a config service from env only (no file I/O). */
    static fromEnv(): HubConfigService;
    /** Resolved agent name: code option > env > cwd basename > "talon". */
    agentName(codeOption?: string): string;
    /** Resolved port: code option > env > default 9090. */
    port(codeOption?: number): number;
    /** Whether dev-mode is active: code option > env TALON_DEV=1. */
    devMode(codeOption?: boolean): boolean;
    /** Resolved TALON_HOME directory. Delegates to hub-settings' getTalonHome(). */
    get talonHome(): string;
    /** Telegram bot token: code option > settings file > env. */
    telegramBotToken(codeOption?: string): string | undefined;
    /** TALON_TRANSPORT value (defaults to "stdio"). */
    talonTransport(): string;
    /** Telegram webhook bind host (defaults to "127.0.0.1"). */
    telegramWebhookHost(codeOption?: string): string;
    /** MCP-HTTP port (defaults to 3100). */
    mcpHttpPort(codeOption?: number): number;
    /** MCP-HTTP bind host (defaults to "127.0.0.1"). */
    mcpHttpHost(codeOption?: string): string;
    /** MCP-HTTP bearer token (optional). */
    mcpHttpToken(codeOption?: string): string | undefined;
    /** MCP-HTTP CORS origins (optional). */
    mcpHttpCors(codeOption?: string): string | undefined;
    /** MCP-HTTP base path (defaults to "/mcp"). */
    mcpHttpPath(codeOption?: string): string;
    /** MCP-HTTP agent name (defaults to "mcp-http-agent"). */
    mcpHttpAgentName(codeOption?: string): string;
    /** WebSocket bind host (defaults to "127.0.0.1"). */
    wsHost(codeOption?: string): string;
    /** Telegram allowed chat IDs (comma-separated string or undefined). */
    telegramAllowedChats(): string | undefined;
    /** Path to Telegram access.json file. */
    telegramAccessPath(): string | undefined;
    /** Path for Telegram file downloads. */
    telegramDownloadPath(): string | undefined;
    /** Telegram group trigger mode (default "mention"). */
    telegramGroupTrigger(): string;
    /** Whether Telegram streaming updates are enabled (default true). */
    telegramStreaming(): boolean;
    /** Telegram webhook port for the high-level channel adapter (default 3000).
     *  When TELEGRAM_WEBHOOK_PORT is set, both channel adapter and transport adapter use it.
     *  When unset, channel adapter defaults to 3000, transport adapter defaults to 3001. */
    telegramWebhookPort(codeOption?: number): number;
    /** Telegram webhook port for TelegramAdapter (transport layer, default 3001).
     *  See telegramWebhookPort() for the channel-adapter variant (default 3000). */
    telegramTransportWebhookPort(codeOption?: number): number;
    /** Telegram webhook path (default "/webhook"). */
    telegramWebhookPath(codeOption?: string): string;
    /** Telegram webhook URL (for setWebhook). */
    telegramWebhookUrl(codeOption?: string): string | undefined;
    /** Telegram webhook secret token. */
    telegramWebhookSecret(codeOption?: string): string | undefined;
    /** Groq API key for voice transcription (TELEGRAM_GROQ_API_KEY or GROQ_API_KEY). */
    groqApiKey(codeOption?: string): string | undefined;
    /** Whisper model name (default "base"). */
    telegramWhisperModel(codeOption?: string): string;
    /** Cohere API key for voice transcription fallback. */
    cohereApiKey(codeOption?: string): string | undefined;
    /** WebSocket server port (default 8080). */
    wsPort(codeOption?: number): number;
    /** WebSocket mode: "server" | "client" | "both" (default "both"). */
    wsMode(codeOption?: string): string;
    /** WebSocket remote URL to connect to (client mode). */
    wsUrl(codeOption?: string): string | undefined;
    /** WebSocket agent name for registration. */
    wsAgentName(codeOption?: string): string | undefined;
    /** WebSocket pairing token. */
    wsPairToken(codeOption?: string): string | undefined;
    /** Whether auto-reconnect is enabled (default true). */
    wsAutoReconnect(): boolean;
    /** Whether HTTP endpoint alongside WS is enabled (default true). */
    wsHttpEnabled(): boolean;
    /** WebSocket group name. */
    wsGroupName(): string | undefined;
    /** WebSocket group access mode (default "public"). */
    wsGroupAccess(): "public" | "private" | "invite";
    /** WebSocket group max members (default 0 = unlimited). */
    wsGroupMaxMembers(): number;
    /** WebSocket group peers (comma-separated URLs, optional). */
    wsGroupPeers(): string[] | undefined;
    /** WebSocket heartbeat interval in ms (default 30000). */
    wsHeartbeatInterval(): number;
    /** Mesh shared secret (enables mesh mode when set). */
    meshSecret(): string | undefined;
    /** Mesh device ID. */
    meshDeviceId(): string | undefined;
    /** Whether mDNS discovery is enabled (default true). */
    meshMdns(): boolean;
    /** Mesh registry URL. */
    meshRegistryUrl(): string | undefined;
    /** Whether E2E encryption is enabled (default false). */
    meshE2e(): boolean;
    matrixHomeserver(): string;
    matrixAccessToken(): string;
    matrixUserId(): string;
    discordToken(): string;
    discordAllowedChannels(): string[];
    slackBotToken(): string;
    slackAppToken(): string;
    slackSigningSecret(): string;
    ircServer(): string;
    ircPort(): number;
    ircNick(): string;
    ircChannels(): string[];
    ircPassword(): string | undefined;
    ircTls(): boolean;
    signalCliUrl(): string;
    signalPhoneNumber(): string;
    whatsappSessionPath(): string;
    lineChannelAccessToken(): string;
    lineChannelSecret(): string;
    lineWebhookPort(): number;
    feishuAppId(): string;
    feishuAppSecret(): string;
    feishuWebhookPort(): number;
    imessagePollInterval(): number;
    imessageAllowedContacts(): string[] | undefined;
    imessageChatDbPath(): string | undefined;
    teamsAppId(): string;
    teamsAppPassword(): string;
    teamsPort(): number;
    /** TALON_CHANNEL value for platform adapter selection (lowercased). */
    talonChannel(): string | undefined;
    /** Whether auto-start server is disabled (TALON_NO_SERVER=1). */
    talonNoServer(): boolean;
    /** Raw TALON_AGENT_NAME env value (may be undefined). Use when you need
     *  the env-only value without cwd/default fallback. */
    get envAgentName(): string | undefined;
    /** Raw TALON_PORT env value parsed as number (may be undefined). */
    get envPort(): number | undefined;
    /** Build a full TalonConfig from code options merged with env/file/defaults. */
    resolve(codeOptions?: {
        name?: string;
        port?: number;
        devMode?: boolean;
    }): TalonConfig;
}
//# sourceMappingURL=hub-config-service.d.ts.map