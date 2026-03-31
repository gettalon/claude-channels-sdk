/**
 * hub-config-service.ts — Centralised configuration for ChannelHub.
 *
 * Reads every environment variable exactly once, merges with config-file
 * values and programmatic options, and exposes a typed config object.
 *
 * Precedence (highest → lowest):
 *   code options  >  config file  >  environment  >  defaults
 */
import { basename } from "node:path";
import { loadSettings, getTalonHome } from "./hub-settings.js";
function snapshotEnv() {
    return {
        TALON_AGENT_NAME: process.env.TALON_AGENT_NAME,
        TALON_PORT: process.env.TALON_PORT,
        TALON_DEV: process.env.TALON_DEV,
        TALON_HOME: process.env.TALON_HOME,
        TALON_TRANSPORT: process.env.TALON_TRANSPORT,
        TALON_CHANNEL: process.env.TALON_CHANNEL,
        TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
        TELEGRAM_WEBHOOK_HOST: process.env.TELEGRAM_WEBHOOK_HOST,
        TELEGRAM_WEBHOOK_PORT: process.env.TELEGRAM_WEBHOOK_PORT,
        TELEGRAM_WEBHOOK_PATH: process.env.TELEGRAM_WEBHOOK_PATH,
        TELEGRAM_WEBHOOK_URL: process.env.TELEGRAM_WEBHOOK_URL,
        TELEGRAM_WEBHOOK_SECRET: process.env.TELEGRAM_WEBHOOK_SECRET,
        TELEGRAM_ALLOWED_CHATS: process.env.TELEGRAM_ALLOWED_CHATS,
        TELEGRAM_ACCESS_PATH: process.env.TELEGRAM_ACCESS_PATH,
        TELEGRAM_DOWNLOAD_PATH: process.env.TELEGRAM_DOWNLOAD_PATH,
        TELEGRAM_GROUP_TRIGGER: process.env.TELEGRAM_GROUP_TRIGGER,
        TELEGRAM_STREAMING: process.env.TELEGRAM_STREAMING,
        TELEGRAM_GROQ_API_KEY: process.env.TELEGRAM_GROQ_API_KEY,
        GROQ_API_KEY: process.env.GROQ_API_KEY,
        TELEGRAM_WHISPER_MODEL: process.env.TELEGRAM_WHISPER_MODEL,
        COHERE_API_KEY: process.env.COHERE_API_KEY,
        MCP_HTTP_PORT: process.env.MCP_HTTP_PORT,
        MCP_HTTP_HOST: process.env.MCP_HTTP_HOST,
        MCP_HTTP_TOKEN: process.env.MCP_HTTP_TOKEN,
        MCP_HTTP_CORS: process.env.MCP_HTTP_CORS,
        MCP_HTTP_PATH: process.env.MCP_HTTP_PATH,
        MCP_HTTP_AGENT_NAME: process.env.MCP_HTTP_AGENT_NAME,
        WS_HOST: process.env.WS_HOST,
        WS_PORT: process.env.WS_PORT,
        WS_MODE: process.env.WS_MODE,
        WS_URL: process.env.WS_URL,
        WS_AGENT_NAME: process.env.WS_AGENT_NAME,
        WS_PAIR_TOKEN: process.env.WS_PAIR_TOKEN,
        WS_AUTO_RECONNECT: process.env.WS_AUTO_RECONNECT,
        WS_HTTP: process.env.WS_HTTP,
        WS_GROUP_NAME: process.env.WS_GROUP_NAME,
        WS_GROUP_ACCESS: process.env.WS_GROUP_ACCESS,
        WS_GROUP_MAX_MEMBERS: process.env.WS_GROUP_MAX_MEMBERS,
        WS_GROUP_PEERS: process.env.WS_GROUP_PEERS,
        WS_HEARTBEAT_INTERVAL: process.env.WS_HEARTBEAT_INTERVAL,
        TALON_NO_SERVER: process.env.TALON_NO_SERVER,
        MESH_SECRET: process.env.MESH_SECRET,
        MESH_DEVICE_ID: process.env.MESH_DEVICE_ID,
        MESH_MDNS: process.env.MESH_MDNS,
        MESH_REGISTRY_URL: process.env.MESH_REGISTRY_URL,
        MESH_E2E: process.env.MESH_E2E,
    };
}
// ── HubConfigService ─────────────────────────────────────────────────────
/**
 * Singleton-style config service.
 *
 * Create via `HubConfigService.create()` (async, reads settings file) or
 * `new HubConfigService(env)` (sync, env-only — no settings file merge).
 */
export class HubConfigService {
    /** Cached env snapshot — avoids repeated process.env reads. */
    env;
    /** Merged settings from config file (may be empty). */
    fileSettings;
    constructor(env, fileSettings = {}) {
        this.env = env;
        this.fileSettings = fileSettings;
    }
    // ── Factory ──────────────────────────────────────────────────────────
    /** Create a config service with settings file merged in. */
    static async create() {
        const env = snapshotEnv();
        const settings = await loadSettings();
        return new HubConfigService(env, settings);
    }
    /** Create a config service from env only (no file I/O). */
    static fromEnv() {
        return new HubConfigService(snapshotEnv());
    }
    // ── Individual accessors ─────────────────────────────────────────────
    /** Resolved agent name: code option > env > cwd basename > "talon". */
    agentName(codeOption) {
        if (codeOption)
            return codeOption;
        if (this.env.TALON_AGENT_NAME)
            return this.env.TALON_AGENT_NAME;
        const cwd = process.cwd();
        const isTempDir = /\/(tmp|temp|var\/folders)\//i.test(cwd) || cwd.includes("dispatch-");
        const cwdName = isTempDir ? null : basename(cwd);
        return cwdName ?? "talon";
    }
    /** Resolved port: code option > env > default 9090. */
    port(codeOption) {
        if (codeOption !== undefined)
            return codeOption;
        if (this.env.TALON_PORT)
            return parseInt(this.env.TALON_PORT, 10);
        return 9090;
    }
    /** Whether dev-mode is active: code option > env TALON_DEV=1. */
    devMode(codeOption) {
        if (codeOption !== undefined)
            return codeOption;
        return this.env.TALON_DEV === "1";
    }
    /** Resolved TALON_HOME directory. Delegates to hub-settings' getTalonHome(). */
    get talonHome() {
        return getTalonHome();
    }
    /** Telegram bot token: code option > settings file > env. */
    telegramBotToken(codeOption) {
        if (codeOption)
            return codeOption;
        const fromFile = this.fileSettings.transports?.telegram?.botToken;
        if (fromFile)
            return fromFile;
        return this.env.TELEGRAM_BOT_TOKEN;
    }
    /** TALON_TRANSPORT value (defaults to "stdio"). */
    talonTransport() {
        return (this.env.TALON_TRANSPORT ?? "stdio").toLowerCase();
    }
    /** Telegram webhook bind host (defaults to "127.0.0.1"). */
    telegramWebhookHost(codeOption) {
        if (codeOption)
            return codeOption;
        return this.env.TELEGRAM_WEBHOOK_HOST ?? "127.0.0.1";
    }
    /** MCP-HTTP port (defaults to 3100). */
    mcpHttpPort(codeOption) {
        if (codeOption !== undefined)
            return codeOption;
        return parseInt(this.env.MCP_HTTP_PORT ?? "3100", 10);
    }
    /** MCP-HTTP bind host (defaults to "127.0.0.1"). */
    mcpHttpHost(codeOption) {
        if (codeOption)
            return codeOption;
        return this.env.MCP_HTTP_HOST ?? "127.0.0.1";
    }
    /** MCP-HTTP bearer token (optional). */
    mcpHttpToken(codeOption) {
        return codeOption ?? this.env.MCP_HTTP_TOKEN;
    }
    /** MCP-HTTP CORS origins (optional). */
    mcpHttpCors(codeOption) {
        return codeOption ?? this.env.MCP_HTTP_CORS;
    }
    /** MCP-HTTP base path (defaults to "/mcp"). */
    mcpHttpPath(codeOption) {
        return codeOption ?? this.env.MCP_HTTP_PATH ?? "/mcp";
    }
    /** MCP-HTTP agent name (defaults to "mcp-http-agent"). */
    mcpHttpAgentName(codeOption) {
        return codeOption ?? this.env.MCP_HTTP_AGENT_NAME ?? "mcp-http-agent";
    }
    /** WebSocket bind host (defaults to "127.0.0.1"). */
    wsHost(codeOption) {
        if (codeOption)
            return codeOption;
        return this.env.WS_HOST ?? "127.0.0.1";
    }
    // ── Telegram channel accessors ───────────────────────────────────────
    /** Telegram allowed chat IDs (comma-separated string or undefined). */
    telegramAllowedChats() {
        return this.env.TELEGRAM_ALLOWED_CHATS;
    }
    /** Path to Telegram access.json file. */
    telegramAccessPath() {
        return this.env.TELEGRAM_ACCESS_PATH;
    }
    /** Path for Telegram file downloads. */
    telegramDownloadPath() {
        return this.env.TELEGRAM_DOWNLOAD_PATH;
    }
    /** Telegram group trigger mode (default "mention"). */
    telegramGroupTrigger() {
        return this.env.TELEGRAM_GROUP_TRIGGER ?? "mention";
    }
    /** Whether Telegram streaming updates are enabled (default true). */
    telegramStreaming() {
        return this.env.TELEGRAM_STREAMING !== "false";
    }
    /** Telegram webhook port for the high-level channel adapter (default 3000).
     *  When TELEGRAM_WEBHOOK_PORT is set, both channel adapter and transport adapter use it.
     *  When unset, channel adapter defaults to 3000, transport adapter defaults to 3001. */
    telegramWebhookPort(codeOption) {
        if (codeOption !== undefined)
            return codeOption;
        return parseInt(this.env.TELEGRAM_WEBHOOK_PORT ?? "3000", 10);
    }
    /** Telegram webhook port for TelegramAdapter (transport layer, default 3001).
     *  See telegramWebhookPort() for the channel-adapter variant (default 3000). */
    telegramTransportWebhookPort(codeOption) {
        if (codeOption !== undefined)
            return codeOption;
        return parseInt(this.env.TELEGRAM_WEBHOOK_PORT ?? "3001", 10);
    }
    /** Telegram webhook path (default "/webhook"). */
    telegramWebhookPath(codeOption) {
        return codeOption ?? this.env.TELEGRAM_WEBHOOK_PATH ?? "/webhook";
    }
    /** Telegram webhook URL (for setWebhook). */
    telegramWebhookUrl(codeOption) {
        return codeOption ?? this.env.TELEGRAM_WEBHOOK_URL;
    }
    /** Telegram webhook secret token. */
    telegramWebhookSecret(codeOption) {
        return codeOption ?? this.env.TELEGRAM_WEBHOOK_SECRET;
    }
    /** Groq API key for voice transcription (TELEGRAM_GROQ_API_KEY or GROQ_API_KEY). */
    groqApiKey(codeOption) {
        return codeOption ?? this.env.TELEGRAM_GROQ_API_KEY ?? this.env.GROQ_API_KEY;
    }
    /** Whisper model name (default "base"). */
    telegramWhisperModel(codeOption) {
        return codeOption ?? this.env.TELEGRAM_WHISPER_MODEL ?? "base";
    }
    /** Cohere API key for voice transcription fallback. */
    cohereApiKey(codeOption) {
        return codeOption ?? this.env.COHERE_API_KEY;
    }
    // ── WebSocket channel accessors ──────────────────────────────────────
    /** WebSocket server port (default 8080). */
    wsPort(codeOption) {
        if (codeOption !== undefined)
            return codeOption;
        return parseInt(this.env.WS_PORT ?? "8080", 10);
    }
    /** WebSocket mode: "server" | "client" | "both" (default "both"). */
    wsMode(codeOption) {
        return codeOption ?? this.env.WS_MODE ?? "both";
    }
    /** WebSocket remote URL to connect to (client mode). */
    wsUrl(codeOption) {
        return codeOption ?? this.env.WS_URL;
    }
    /** WebSocket agent name for registration. */
    wsAgentName(codeOption) {
        return codeOption ?? this.env.WS_AGENT_NAME;
    }
    /** WebSocket pairing token. */
    wsPairToken(codeOption) {
        return codeOption ?? this.env.WS_PAIR_TOKEN;
    }
    /** Whether auto-reconnect is enabled (default true). */
    wsAutoReconnect() {
        return this.env.WS_AUTO_RECONNECT !== "false";
    }
    /** Whether HTTP endpoint alongside WS is enabled (default true). */
    wsHttpEnabled() {
        return this.env.WS_HTTP !== "false";
    }
    /** WebSocket group name. */
    wsGroupName() {
        return this.env.WS_GROUP_NAME;
    }
    /** WebSocket group access mode (default "public"). */
    wsGroupAccess() {
        return (this.env.WS_GROUP_ACCESS ?? "public");
    }
    /** WebSocket group max members (default 0 = unlimited). */
    wsGroupMaxMembers() {
        return parseInt(this.env.WS_GROUP_MAX_MEMBERS ?? "0", 10);
    }
    /** WebSocket group peers (comma-separated URLs, optional). */
    wsGroupPeers() {
        const raw = this.env.WS_GROUP_PEERS;
        if (!raw)
            return undefined;
        return raw.split(",").map((s) => s.trim()).filter(Boolean);
    }
    /** WebSocket heartbeat interval in ms (default 30000). */
    wsHeartbeatInterval() {
        return parseInt(this.env.WS_HEARTBEAT_INTERVAL ?? "30000", 10);
    }
    // ── Mesh accessors ───────────────────────────────────────────────────
    /** Mesh shared secret (enables mesh mode when set). */
    meshSecret() {
        return this.env.MESH_SECRET;
    }
    /** Mesh device ID. */
    meshDeviceId() {
        return this.env.MESH_DEVICE_ID;
    }
    /** Whether mDNS discovery is enabled (default true). */
    meshMdns() {
        return this.env.MESH_MDNS !== "false";
    }
    /** Mesh registry URL. */
    meshRegistryUrl() {
        return this.env.MESH_REGISTRY_URL;
    }
    /** Whether E2E encryption is enabled (default false). */
    meshE2e() {
        return this.env.MESH_E2E === "true";
    }
    // ── Talon bootstrap accessor ─────────────────────────────────────────
    /** TALON_CHANNEL value for platform adapter selection (lowercased). */
    talonChannel() {
        return this.env.TALON_CHANNEL?.toLowerCase();
    }
    /** Whether auto-start server is disabled (TALON_NO_SERVER=1). */
    talonNoServer() {
        return this.env.TALON_NO_SERVER === "1";
    }
    /** Raw TALON_AGENT_NAME env value (may be undefined). Use when you need
     *  the env-only value without cwd/default fallback. */
    get envAgentName() {
        return this.env.TALON_AGENT_NAME;
    }
    /** Raw TALON_PORT env value parsed as number (may be undefined). */
    get envPort() {
        return this.env.TALON_PORT ? parseInt(this.env.TALON_PORT, 10) : undefined;
    }
    // ── Full config snapshot ─────────────────────────────────────────────
    /** Build a full TalonConfig from code options merged with env/file/defaults. */
    resolve(codeOptions = {}) {
        const fileNetwork = this.fileSettings.network ?? {};
        return {
            agentName: this.agentName(codeOptions.name),
            port: this.port(codeOptions.port),
            devMode: this.devMode(codeOptions.devMode),
            talonHome: this.talonHome,
            telegramBotToken: this.telegramBotToken(),
            network: {
                bindHost: fileNetwork.bindHost ?? "127.0.0.1",
                corsOrigins: fileNetwork.corsOrigins,
                authToken: fileNetwork.authToken,
            },
        };
    }
}
//# sourceMappingURL=hub-config-service.js.map