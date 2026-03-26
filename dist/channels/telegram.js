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
class TelegramApiError extends Error {
    status;
    errorCode;
    retryAfter;
    constructor(method, status, payload) {
        super(payload?.description ?? `${method} failed with status ${status}`);
        this.name = "TelegramApiError";
        this.status = status;
        this.errorCode = payload?.error_code;
        this.retryAfter = payload?.parameters?.retry_after;
    }
}
export function parseConfig() {
    const botToken = process.env.TELEGRAM_BOT_TOKEN ?? "";
    if (!botToken) {
        throw new Error("TELEGRAM_BOT_TOKEN is required");
    }
    const allowedChats = process.env.TELEGRAM_ALLOWED_CHATS
        ?.split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    const accessPath = process.env.TELEGRAM_ACCESS_PATH;
    const downloadPath = process.env.TELEGRAM_DOWNLOAD_PATH;
    const groupTrigger = process.env.TELEGRAM_GROUP_TRIGGER ?? "mention";
    const streamingUpdates = process.env.TELEGRAM_STREAMING !== "false";
    const webhookPort = parseInt(process.env.TELEGRAM_WEBHOOK_PORT ?? "3000", 10);
    const webhookHost = process.env.TELEGRAM_WEBHOOK_HOST ?? "0.0.0.0";
    const webhookPath = process.env.TELEGRAM_WEBHOOK_PATH ?? "/webhook";
    const webhookUrl = process.env.TELEGRAM_WEBHOOK_URL;
    const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
    const groqApiKey = process.env.TELEGRAM_GROQ_API_KEY ?? process.env.GROQ_API_KEY;
    const whisperModel = process.env.TELEGRAM_WHISPER_MODEL ?? "base";
    return {
        botToken,
        allowedChats,
        accessPath,
        downloadPath,
        groupTrigger,
        streamingUpdates,
        webhookPort,
        webhookHost,
        webhookPath,
        webhookUrl,
        webhookSecret,
        groqApiKey,
        whisperModel,
    };
}
function defaultAccess() {
    return {
        dm: { policy: "pairing", allowed_users: [], admin_users: [] },
        group: { policy: "pairing", allowed_users: [], admin_users: [] },
        pending_pairings: {},
    };
}
async function loadAccess(path) {
    const { readFileSync } = await import("node:fs");
    try {
        const raw = readFileSync(path, "utf-8");
        const data = JSON.parse(raw);
        return { ...defaultAccess(), ...data };
    }
    catch {
        return defaultAccess();
    }
}
async function saveAccess(path, access) {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const { dirname } = await import("node:path");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(access, null, 2));
}
function generatePairingCode() {
    return Math.random().toString(36).slice(2, 8).toUpperCase();
}
const MAX_MSG_LEN = 4096;
function chunkText(text, limit) {
    if (text.length <= limit) {
        return [text];
    }
    const chunks = [];
    let remaining = text;
    const effectiveLimit = limit - 4;
    while (remaining.length > 0) {
        if (remaining.length <= limit) {
            chunks.push(remaining);
            break;
        }
        let splitAt = remaining.lastIndexOf("\n", effectiveLimit);
        if (splitAt < effectiveLimit * 0.5) {
            splitAt = remaining.lastIndexOf(" ", effectiveLimit);
        }
        if (splitAt <= 0) {
            splitAt = effectiveLimit;
        }
        chunks.push(`${remaining.slice(0, splitAt)}\n\u23ec`);
        remaining = remaining.slice(splitAt).replace(/^\n/, "");
    }
    return chunks;
}
function mdToHtml(md) {
    let html = md;
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, _lang, code) => `<pre>${escapeHtml(code.trimEnd())}</pre>`);
    html = html.replace(/`([^`]+)`/g, (_m, code) => `<code>${escapeHtml(code)}</code>`);
    html = html.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
    html = html.replace(/__(.+?)__/g, "<b>$1</b>");
    html = html.replace(/~~(.+?)~~/g, "<s>$1</s>");
    html = html.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "<i>$1</i>");
    html = html.replace(/(?<!_)_(?!_)(.+?)(?<!_)_(?!_)/g, "<i>$1</i>");
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
    html = html.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");
    html = html.replace(/^[-*]\s+/gm, "\u2022 ");
    return html;
}
function escapeHtml(text) {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function sanitizeFilename(text) {
    return text.replace(/[^a-zA-Z0-9._-]/g, "_");
}
function normalizeWebhookPath(path) {
    if (!path || path === "/") {
        return "/webhook";
    }
    return path.startsWith("/") ? path : `/${path}`;
}
function constantTimeEquals(a, b) {
    if (a.length !== b.length) {
        return false;
    }
    let result = 0;
    for (let index = 0; index < a.length; index += 1) {
        result |= a.charCodeAt(index) ^ b.charCodeAt(index);
    }
    return result === 0;
}
function isImagePath(path) {
    return /\.(png|jpe?g|gif|webp|bmp)$/i.test(path);
}
function mimeTypeForPath(path) {
    if (/\.png$/i.test(path))
        return "image/png";
    if (/\.gif$/i.test(path))
        return "image/gif";
    if (/\.webp$/i.test(path))
        return "image/webp";
    if (/\.jpg$/i.test(path) || /\.jpeg$/i.test(path))
        return "image/jpeg";
    if (/\.ogg$/i.test(path))
        return "audio/ogg";
    return "application/octet-stream";
}
function encodeBase64(buffer) {
    return Buffer.from(buffer).toString("base64");
}
async function sleep(ms) {
    await new Promise((resolve) => setTimeout(resolve, ms));
}
const EXTRA_TOOLS = [
    {
        name: "telegram_send",
        description: "Send a message to a Telegram chat with optional files and inline buttons",
        inputSchema: {
            type: "object",
            properties: {
                chat_id: { type: "string", description: "Chat ID to send to" },
                text: { type: "string", description: "Message text" },
                reply_to: { type: "string", description: "Message ID to reply to (optional)" },
                parse_mode: { type: "string", enum: ["text", "html"], description: "Parse mode (default: text)" },
                files: { type: "array", items: { type: "string" }, description: "File paths to attach" },
                buttons: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: { text: { type: "string" }, callback_data: { type: "string" } },
                    },
                    description: "Inline keyboard buttons",
                },
            },
            required: ["chat_id", "text"],
        },
    },
    {
        name: "telegram_react",
        description: "Add an emoji reaction to a Telegram message",
        inputSchema: {
            type: "object",
            properties: {
                chat_id: { type: "string", description: "Chat ID" },
                message_id: { type: "string", description: "Message ID to react to" },
                emoji: { type: "string", description: "Emoji to react with" },
            },
            required: ["chat_id", "message_id", "emoji"],
        },
    },
    {
        name: "telegram_edit",
        description: "Edit a previously sent Telegram message",
        inputSchema: {
            type: "object",
            properties: {
                chat_id: { type: "string", description: "Chat ID" },
                message_id: { type: "string", description: "Message ID to edit" },
                text: { type: "string", description: "New message text" },
                parse_mode: { type: "string", enum: ["text", "html"], description: "Parse mode" },
            },
            required: ["chat_id", "message_id", "text"],
        },
    },
    {
        name: "telegram_poll",
        description: "Send a poll to a Telegram chat",
        inputSchema: {
            type: "object",
            properties: {
                chat_id: { type: "string", description: "Chat ID" },
                question: { type: "string", description: "Poll question" },
                options: { type: "array", items: { type: "string" }, description: "Poll options (2-10)" },
                allow_multiple: { type: "boolean", description: "Allow multiple answers" },
                is_anonymous: { type: "boolean", description: "Anonymous poll (default true)" },
            },
            required: ["chat_id", "question", "options"],
        },
    },
    {
        name: "telegram_download",
        description: "Download a file from Telegram (photo, document, voice) by file_id and save to disk",
        inputSchema: {
            type: "object",
            properties: {
                file_id: { type: "string", description: "Telegram file_id from message meta" },
                filename: { type: "string", description: "Output filename (optional, auto-generated if omitted)" },
            },
            required: ["file_id"],
        },
    },
];
export async function createTelegramChannel(config) {
    const http = await import("node:http");
    const { join, basename } = await import("node:path");
    const { homedir, tmpdir } = await import("node:os");
    const { mkdirSync } = await import("node:fs");
    const { readFile, writeFile, unlink } = await import("node:fs/promises");
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    const cfg = { ...parseConfig(), ...config };
    if (!cfg.botToken) {
        throw new Error("TELEGRAM_BOT_TOKEN is required");
    }
    const accessPath = cfg.accessPath ?? join(homedir(), ".claude", "channels", "telegram", "access.json");
    const downloadDir = cfg.downloadPath ?? join(tmpdir(), "talon-telegram-downloads");
    const webhookPort = cfg.webhookPort ?? 3000;
    const webhookHost = cfg.webhookHost ?? "0.0.0.0";
    const webhookPath = normalizeWebhookPath(cfg.webhookPath);
    const webhookSecret = cfg.webhookSecret;
    mkdirSync(downloadDir, { recursive: true });
    let access = await loadAccess(accessPath);
    if (cfg.allowedChats && cfg.allowedChats.length > 0) {
        for (const id of cfg.allowedChats) {
            if (!access.dm.allowed_users.includes(id)) {
                access.dm.allowed_users.push(id);
            }
        }
        access.dm.policy = "pairing";
        await saveAccess(accessPath, access);
    }
    let botUsername = "";
    let shuttingDown = false;
    let webhookRegistered = false;
    const pendingPermissions = new Map();
    const activeChats = new Set();
    const typingIntervals = new Map();
    const streamingStatus = new Map();
    const streamingEnabled = new Map();
    function isStreamingEnabled(chatId) {
        return streamingEnabled.get(chatId) ?? (cfg.streamingUpdates !== false);
    }
    function apiUrl(method) {
        return `https://api.telegram.org/bot${cfg.botToken}/${method}`;
    }
    function fileUrl(filePath) {
        return `https://api.telegram.org/file/bot${cfg.botToken}/${filePath}`;
    }
    async function parseEnvelope(response) {
        try {
            return await response.json();
        }
        catch {
            return null;
        }
    }
    async function requestJson(method, body, maxRetries = 3) {
        for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
            const response = await fetch(apiUrl(method), {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(body),
            });
            const payload = await parseEnvelope(response);
            const ok = response.ok && payload?.ok !== false;
            if (ok) {
                return payload?.result;
            }
            const retryAfter = payload?.parameters?.retry_after ?? Number(response.headers.get("retry-after") ?? "0");
            if ((response.status === 429 || payload?.error_code === 429) && attempt < maxRetries) {
                await sleep((retryAfter > 0 ? retryAfter : 5) * 1000);
                continue;
            }
            throw new TelegramApiError(method, response.status, payload);
        }
        throw new Error(`${method} failed`);
    }
    async function requestMultipart(method, buildForm, maxRetries = 1) {
        for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
            const response = await fetch(apiUrl(method), {
                method: "POST",
                body: buildForm(),
            });
            const payload = await parseEnvelope(response);
            const ok = response.ok && payload?.ok !== false;
            if (ok) {
                return payload?.result;
            }
            const retryAfter = payload?.parameters?.retry_after ?? Number(response.headers.get("retry-after") ?? "0");
            if ((response.status === 429 || payload?.error_code === 429) && attempt < maxRetries) {
                await sleep((retryAfter > 0 ? retryAfter : 5) * 1000);
                continue;
            }
            throw new TelegramApiError(method, response.status, payload);
        }
        throw new Error(`${method} failed`);
    }
    async function sendMessage(chatId, text, opts = {}) {
        const body = {
            chat_id: chatId,
            text,
        };
        if (opts.parseMode === "HTML") {
            body.parse_mode = "HTML";
        }
        if (opts.replyTo !== undefined) {
            body.reply_parameters = { message_id: opts.replyTo };
        }
        if (opts.threadId !== undefined) {
            body.message_thread_id = opts.threadId;
        }
        if (opts.replyMarkup) {
            body.reply_markup = opts.replyMarkup;
        }
        return requestJson("sendMessage", body);
    }
    async function editMessageText(chatId, messageId, text, opts = {}) {
        const body = {
            chat_id: chatId,
            message_id: messageId,
            text,
        };
        if (opts.parseMode === "HTML") {
            body.parse_mode = "HTML";
        }
        if (opts.replyMarkup) {
            body.reply_markup = opts.replyMarkup;
        }
        await requestJson("editMessageText", body, 1);
    }
    async function deleteMessage(chatId, messageId) {
        await requestJson("deleteMessage", { chat_id: chatId, message_id: messageId }, 1);
    }
    async function answerCallbackQuery(callbackQueryId, text) {
        const body = { callback_query_id: callbackQueryId };
        if (text) {
            body.text = text;
        }
        await requestJson("answerCallbackQuery", body, 1);
    }
    async function setMessageReaction(chatId, messageId, emoji) {
        const reaction = emoji ? [{ type: "emoji", emoji }] : [];
        await requestJson("setMessageReaction", {
            chat_id: chatId,
            message_id: messageId,
            reaction,
        }, 1);
    }
    async function sendChatAction(chatId) {
        await requestJson("sendChatAction", { chat_id: chatId, action: "typing" }, 1);
    }
    async function setMyCommands(commands) {
        await requestJson("setMyCommands", { commands }, 1);
    }
    async function getMe() {
        return requestJson("getMe", {}, 1);
    }
    async function setWebhook(url, secret) {
        const body = {
            url,
            allowed_updates: ["message", "callback_query"],
            drop_pending_updates: true,
        };
        if (secret) {
            body.secret_token = secret;
        }
        await requestJson("setWebhook", body, 1);
    }
    async function deleteWebhook() {
        await requestJson("deleteWebhook", { drop_pending_updates: true }, 1);
    }
    async function getFile(fileId) {
        return requestJson("getFile", { file_id: fileId }, 1);
    }
    async function sendInlineKeyboard(chatId, text, buttons, opts = {}) {
        const result = await sendMessage(chatId, text, {
            ...opts,
            replyMarkup: { inline_keyboard: buttons },
        });
        return result.message_id;
    }
    async function sendPhoto(chatId, filePath, caption, opts = {}) {
        const data = await readFile(filePath);
        await requestMultipart("sendPhoto", () => {
            const form = new FormData();
            form.append("chat_id", chatId);
            form.append("photo", new Blob([data], { type: mimeTypeForPath(filePath) }), basename(filePath));
            if (caption) {
                form.append("caption", caption);
            }
            if (opts.parseMode === "HTML") {
                form.append("parse_mode", "HTML");
            }
            if (opts.replyTo !== undefined) {
                form.append("reply_parameters", JSON.stringify({ message_id: opts.replyTo }));
            }
            if (opts.threadId !== undefined) {
                form.append("message_thread_id", String(opts.threadId));
            }
            if (opts.replyMarkup) {
                form.append("reply_markup", JSON.stringify(opts.replyMarkup));
            }
            return form;
        });
    }
    async function sendDocument(chatId, filePath, caption, opts = {}) {
        const data = await readFile(filePath);
        await requestMultipart("sendDocument", () => {
            const form = new FormData();
            form.append("chat_id", chatId);
            form.append("document", new Blob([data], { type: mimeTypeForPath(filePath) }), basename(filePath));
            if (caption) {
                form.append("caption", caption);
            }
            if (opts.parseMode === "HTML") {
                form.append("parse_mode", "HTML");
            }
            if (opts.replyTo !== undefined) {
                form.append("reply_parameters", JSON.stringify({ message_id: opts.replyTo }));
            }
            if (opts.threadId !== undefined) {
                form.append("message_thread_id", String(opts.threadId));
            }
            if (opts.replyMarkup) {
                form.append("reply_markup", JSON.stringify(opts.replyMarkup));
            }
            return form;
        });
    }
    async function sendOutputFile(chatId, filePath, opts = {}) {
        if (isImagePath(filePath)) {
            await sendPhoto(chatId, filePath, undefined, opts);
            return;
        }
        await sendDocument(chatId, filePath, undefined, opts);
    }
    async function sendPoll(chatId, question, options, allowMultiple, isAnonymous) {
        return requestJson("sendPoll", {
            chat_id: chatId,
            question,
            options,
            allows_multiple_answers: allowMultiple,
            is_anonymous: isAnonymous,
        });
    }
    async function downloadFile(fileId, filename) {
        const file = await getFile(fileId);
        if (!file.file_path) {
            throw new Error("No file_path from Telegram");
        }
        const response = await fetch(fileUrl(file.file_path));
        if (!response.ok) {
            throw new Error(`Download failed: ${response.status}`);
        }
        const data = new Uint8Array(await response.arrayBuffer());
        const ext = file.file_path.split(".").pop() ?? "";
        const outName = filename ?? `${sanitizeFilename(fileId.slice(0, 12))}${ext ? `.${sanitizeFilename(ext)}` : ""}`;
        const outPath = join(downloadDir, sanitizeFilename(outName));
        await writeFile(outPath, data);
        return outPath;
    }
    async function downloadPhotoAsDataUri(fileId) {
        const file = await getFile(fileId);
        if (!file.file_path) {
            return undefined;
        }
        const response = await fetch(fileUrl(file.file_path));
        if (!response.ok) {
            return undefined;
        }
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength > 512 * 1024) {
            return undefined;
        }
        const mimeType = mimeTypeForPath(file.file_path);
        return `data:${mimeType};base64,${encodeBase64(bytes)}`;
    }
    async function transcribeVoiceGroq(filePath) {
        if (!cfg.groqApiKey) {
            return undefined;
        }
        try {
            const data = await readFile(filePath);
            const form = new FormData();
            form.append("model", "whisper-large-v3");
            form.append("file", new Blob([data], { type: mimeTypeForPath(filePath) }), basename(filePath));
            const response = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${cfg.groqApiKey}`,
                },
                body: form,
            });
            if (!response.ok) {
                return undefined;
            }
            const payload = await response.json();
            return payload.text?.trim() || undefined;
        }
        catch {
            return undefined;
        }
    }
    async function transcribeVoiceLocal(filePath) {
        const model = cfg.whisperModel ?? "base";
        const outputDir = downloadDir;
        const stem = basename(filePath).replace(/\.[^.]+$/, "");
        const txtPath = join(outputDir, `${stem}.txt`);
        try {
            await execFileAsync("whisper", [
                filePath,
                "--model",
                model,
                "--output_format",
                "txt",
                "--output_dir",
                outputDir,
            ]);
            const text = (await readFile(txtPath, "utf-8")).trim();
            await unlink(txtPath).catch(() => { });
            return text || undefined;
        }
        catch {
            await unlink(txtPath).catch(() => { });
            return undefined;
        }
    }
    async function transcribeVoice(filePath) {
        const groqText = await transcribeVoiceGroq(filePath);
        if (groqText) {
            return groqText;
        }
        return transcribeVoiceLocal(filePath);
    }
    function isAllowed(userId, chatType) {
        const isGroup = chatType !== "private";
        const policy = isGroup ? access.group : access.dm;
        if (policy.policy === "open") {
            return true;
        }
        if (policy.policy === "disabled") {
            return false;
        }
        return policy.allowed_users.includes(userId) || policy.admin_users.includes(userId);
    }
    function isAdmin(userId) {
        return access.dm.admin_users.includes(userId) || access.group.admin_users.includes(userId);
    }
    function startTyping(chatId) {
        if (typingIntervals.has(chatId)) {
            return;
        }
        const send = () => {
            void sendChatAction(chatId).catch(() => { });
        };
        send();
        typingIntervals.set(chatId, setInterval(send, 4000));
    }
    function stopTyping(chatId) {
        const interval = typingIntervals.get(chatId);
        if (interval) {
            clearInterval(interval);
            typingIntervals.delete(chatId);
        }
    }
    async function updateStreamingStatus(chatId, toolName) {
        if (!isStreamingEnabled(chatId)) {
            return;
        }
        const existing = streamingStatus.get(chatId);
        const now = Date.now();
        if (existing) {
            existing.tools.push(toolName);
            if (now - existing.lastUpdate < 1500) {
                return;
            }
            existing.lastUpdate = now;
            const toolList = existing.tools.slice(-5).map((item) => `\u2022 ${escapeHtml(item)}`).join("\n");
            try {
                await editMessageText(chatId, existing.messageId, `\u2699\ufe0f <i>Working...</i>\n\n${toolList}`, { parseMode: "HTML" });
            }
            catch { }
            return;
        }
        try {
            const msg = await sendMessage(chatId, `\u2699\ufe0f <i>Working on: ${escapeHtml(toolName)}...</i>`, { parseMode: "HTML" });
            if (msg.message_id !== undefined) {
                streamingStatus.set(chatId, {
                    messageId: msg.message_id,
                    tools: [toolName],
                    lastUpdate: now,
                });
            }
        }
        catch { }
    }
    async function clearStreamingStatus(chatId) {
        const existing = streamingStatus.get(chatId);
        if (!existing) {
            return;
        }
        try {
            await deleteMessage(chatId, existing.messageId);
        }
        catch { }
        streamingStatus.delete(chatId);
    }
    const channel = new ChannelServer({
        name: "telegram",
        version: "1.1.0",
        instructions: [
            "You are connected to Telegram via a bot webhook. Messages arrive as channel notifications with chat_id in meta.",
            "Use the reply tool to respond. For advanced features use telegram_send, telegram_react, telegram_edit, telegram_poll.",
            "Messages support HTML formatting. Keep messages under 4096 characters; longer content is auto-chunked.",
            "Permission requests appear as inline keyboard buttons in the chat. The user taps Allow or Deny.",
        ].join(" "),
        permissionRelay: true,
        extraTools: EXTRA_TOOLS,
    });
    async function sendTextResponse(chatId, text) {
        const html = mdToHtml(text);
        const chunks = chunkText(html, MAX_MSG_LEN);
        for (let index = 0; index < chunks.length; index += 1) {
            if (index > 0) {
                await sleep(300);
            }
            try {
                await sendMessage(chatId, chunks[index], { parseMode: "HTML" });
            }
            catch (error) {
                const err = error;
                if (index === 0 && (err.errorCode === 400 || err.status === 400)) {
                    try {
                        await sendMessage(chatId, text);
                    }
                    catch (plainError) {
                        process.stderr.write(`[telegram] Failed to send to ${chatId}: ${plainError.message}\n`);
                    }
                    return;
                }
                process.stderr.write(`[telegram] Send error: ${err.message}\n`);
                return;
            }
        }
    }
    async function handlePairing(message, userId, username, chatId) {
        const chatType = message.chat?.type ?? "private";
        const policy = chatType === "private" ? access.dm : access.group;
        if (policy.policy === "disabled" || policy.policy === "open") {
            return;
        }
        const hasAnyUsers = access.dm.allowed_users.length > 0 || access.dm.admin_users.length > 0;
        if (!hasAnyUsers) {
            access.dm.allowed_users.push(userId);
            access.dm.admin_users.push(userId);
            access.group.allowed_users.push(userId);
            access.group.admin_users.push(userId);
            await saveAccess(accessPath, access);
            process.stderr.write(`[telegram] Auto-approved first user as admin: ${username} (${userId})\n`);
            await sendMessage(chatId, "<b>Welcome!</b>\n\nYou're the first user and have been auto-approved as admin.", {
                parseMode: "HTML",
            });
            return;
        }
        const existing = Object.values(access.pending_pairings).find((pairing) => pairing.user_id === userId);
        if (existing) {
            await sendMessage(chatId, `Your pairing request is pending.\nCode: <code>${existing.code}</code>\nAsk an admin to run: /approve ${existing.code}`, { parseMode: "HTML" });
            return;
        }
        const code = generatePairingCode();
        const pairingId = `${userId}-${Date.now()}`;
        access.pending_pairings[pairingId] = {
            code,
            user_id: userId,
            username,
            chat_id: chatId,
            ts: Date.now(),
        };
        await saveAccess(accessPath, access);
        await sendMessage(chatId, [
            "<b>Pairing Required</b>",
            "",
            `Your code: <code>${code}</code>`,
            "",
            "Ask an admin to approve you with:",
            `<code>/approve ${code}</code>`,
        ].join("\n"), { parseMode: "HTML" });
        const adminIds = [...new Set([...access.dm.admin_users, ...access.group.admin_users])];
        const keyboard = {
            inline_keyboard: [[{ text: `Approve ${username}`, callback_data: `pair:${pairingId}:approve` }]],
        };
        for (const adminId of adminIds) {
            try {
                await sendMessage(adminId, `<b>Pairing Request</b>\n\nUser: @${escapeHtml(username)} (${userId})\nCode: <code>${code}</code>`, {
                    parseMode: "HTML",
                    replyMarkup: keyboard,
                });
            }
            catch { }
        }
    }
    function extractIncomingInfo(message) {
        const chatId = message.chat?.id;
        const chatType = message.chat?.type ?? "private";
        const userId = message.from?.id;
        if (chatId === undefined || userId === undefined) {
            return null;
        }
        const fallbackName = [message.from?.first_name, message.from?.last_name].filter(Boolean).join(" ");
        const username = (message.from?.username ?? fallbackName) || "unknown";
        return {
            chatId: String(chatId),
            userId: String(userId),
            username,
            isGroup: chatType !== "private",
            chatType,
        };
    }
    async function checkAccess(message) {
        const info = extractIncomingInfo(message);
        if (!info) {
            return null;
        }
        if (!isAllowed(info.userId, info.chatType)) {
            await handlePairing(message, info.userId, info.username, info.chatId);
            return null;
        }
        if (info.isGroup && cfg.groupTrigger === "never") {
            return null;
        }
        if (info.isGroup && cfg.groupTrigger === "mention") {
            const text = (message.text ?? message.caption ?? "").toLowerCase();
            const mention = botUsername ? `@${botUsername.toLowerCase()}` : "";
            const replyToBot = message.reply_to_message?.from?.is_bot === true
                || message.reply_to_message?.from?.username?.toLowerCase() === botUsername.toLowerCase();
            const mentioned = mention ? text.includes(mention) : false;
            if (!mentioned && !replyToBot) {
                return null;
            }
        }
        return info;
    }
    function buildMeta(message, chatId, username, extra) {
        const meta = {
            chat_id: chatId,
            user: username,
            ...(message.message_id !== undefined ? { message_id: String(message.message_id) } : {}),
            ...(message.date !== undefined ? { ts: String(message.date) } : {}),
            ...(message.message_thread_id !== undefined ? { thread_id: String(message.message_thread_id) } : {}),
            ...(extra ?? {}),
        };
        const reply = message.reply_to_message;
        if (reply) {
            if (reply.message_id !== undefined) {
                meta.reply_to_id = String(reply.message_id);
            }
            const replyFallbackName = [reply.from?.first_name, reply.from?.last_name].filter(Boolean).join(" ");
            meta.reply_to_user = (reply.from?.username ?? replyFallbackName) || "unknown";
            if (reply.text) {
                meta.reply_to_text = reply.text.slice(0, 200);
            }
        }
        if (message.forward_origin) {
            const origin = message.forward_origin;
            if (origin.type === "user") {
                meta.forwarded_from =
                    origin.sender_user?.username
                        ?? origin.sender_user?.first_name
                        ?? "unknown";
            }
            else if (origin.type === "channel") {
                meta.forwarded_from = origin.chat?.title ?? "channel";
            }
            else if (origin.type === "hidden_user") {
                meta.forwarded_from = origin.sender_user_name ?? "hidden";
            }
        }
        else if (message.forward_from || message.forward_from_chat) {
            meta.forwarded_from =
                message.forward_from?.username
                    ?? message.forward_from?.first_name
                    ?? message.forward_from_chat?.title
                    ?? "unknown";
        }
        return meta;
    }
    function parseCommand(messageText) {
        if (!messageText.startsWith("/")) {
            return null;
        }
        const [firstWord, ...rest] = messageText.trim().split(/\s+/);
        const commandPart = firstWord.slice(1);
        const [rawCommand, targetBot] = commandPart.split("@");
        if (targetBot && botUsername && targetBot.toLowerCase() !== botUsername.toLowerCase()) {
            return null;
        }
        return {
            command: rawCommand.toLowerCase(),
            arg: rest.join(" ").trim(),
        };
    }
    async function handleCommand(message) {
        const info = extractIncomingInfo(message);
        if (!info) {
            return false;
        }
        const text = message.text ?? "";
        const parsed = parseCommand(text);
        if (!parsed) {
            return false;
        }
        const { command, arg } = parsed;
        if (command !== "approve" && !isAllowed(info.userId, info.chatType)) {
            await handlePairing(message, info.userId, info.username, info.chatId);
            return true;
        }
        switch (command) {
            case "start": {
                const keyboard = {
                    inline_keyboard: [
                        [{ text: "Status", callback_data: "cmd:status" }, { text: "Help", callback_data: "cmd:help" }],
                        [{ text: "Stop", callback_data: "cmd:stop" }, { text: "New Chat", callback_data: "cmd:new" }],
                    ],
                };
                await sendMessage(info.chatId, "<b>Talon Channels</b>\n\nConnected to Claude Code via Telegram.\nSend any message to start chatting.", { parseMode: "HTML", replyMarkup: keyboard });
                return true;
            }
            case "help": {
                await sendMessage(info.chatId, [
                    "<b>Commands</b>",
                    "",
                    "/start - Welcome message",
                    "/help - This help",
                    "/status - Connection status",
                    "/stop - Interrupt current task",
                    "/new - Clear conversation context",
                    "/streaming - Toggle live tool status updates",
                    "/approve <code> - Approve a pairing request (admin)",
                ].join("\n"), { parseMode: "HTML" });
                return true;
            }
            case "status": {
                const pendingCount = Object.keys(access.pending_pairings).length;
                const policy = info.isGroup ? access.group : access.dm;
                await sendMessage(info.chatId, [
                    "<b>Status</b>",
                    "",
                    `<b>Chat:</b> ${info.chatId}`,
                    `<b>User:</b> ${info.userId}`,
                    `<b>Admin:</b> ${isAdmin(info.userId) ? "Yes" : "No"}`,
                    `<b>Policy:</b> ${policy.policy}`,
                    `<b>Allowed users:</b> ${policy.allowed_users.length}`,
                    `<b>Pending pairings:</b> ${pendingCount}`,
                    `<b>Bot:</b> @${escapeHtml(botUsername || "unknown")}`,
                ].join("\n"), { parseMode: "HTML" });
                return true;
            }
            case "stop": {
                await sendMessage(info.chatId, "Stop signal sent.");
                await channel.pushMessage("/stop", {
                    chat_id: info.chatId,
                    user: info.username,
                    ...(message.message_id !== undefined ? { message_id: String(message.message_id) } : {}),
                });
                return true;
            }
            case "new": {
                await sendMessage(info.chatId, "Conversation context cleared.");
                await channel.pushMessage("/new - start fresh conversation", {
                    chat_id: info.chatId,
                    user: info.username,
                    ...(message.message_id !== undefined ? { message_id: String(message.message_id) } : {}),
                });
                return true;
            }
            case "streaming": {
                const next = !isStreamingEnabled(info.chatId);
                streamingEnabled.set(info.chatId, next);
                await sendMessage(info.chatId, `Streaming status updates: <b>${next ? "ON" : "OFF"}</b>`, {
                    parseMode: "HTML",
                });
                return true;
            }
            case "approve": {
                if (!isAdmin(info.userId)) {
                    await sendMessage(info.chatId, "Only admins can approve pairing requests.");
                    return true;
                }
                const code = arg.toUpperCase();
                if (!code) {
                    await sendMessage(info.chatId, "Usage: /approve <code>");
                    return true;
                }
                const entry = Object.entries(access.pending_pairings).find(([, value]) => value.code === code);
                if (!entry) {
                    await sendMessage(info.chatId, `No pending pairing with code: ${code}`);
                    return true;
                }
                const [pairingId, pairing] = entry;
                if (!access.dm.allowed_users.includes(pairing.user_id)) {
                    access.dm.allowed_users.push(pairing.user_id);
                }
                if (!access.group.allowed_users.includes(pairing.user_id)) {
                    access.group.allowed_users.push(pairing.user_id);
                }
                delete access.pending_pairings[pairingId];
                await saveAccess(accessPath, access);
                await sendMessage(info.chatId, `Approved @${pairing.username} (${pairing.user_id})`);
                try {
                    await sendMessage(pairing.chat_id, "You've been approved! Send any message to start chatting.");
                }
                catch { }
                return true;
            }
            default:
                return false;
        }
    }
    async function handleTextMessage(message) {
        const info = await checkAccess(message);
        if (!info || !message.text) {
            return;
        }
        activeChats.add(info.chatId);
        startTyping(info.chatId);
        let messageText = message.text;
        if (info.isGroup) {
            messageText = `[From: ${info.username} (id:${info.userId})]\n${messageText}`;
        }
        const reply = message.reply_to_message;
        if (reply?.text) {
            const replyFallbackName = [reply.from?.first_name, reply.from?.last_name].filter(Boolean).join(" ");
            const replyUser = (reply.from?.username ?? replyFallbackName) || "user";
            messageText = `[Replying to ${replyUser}: "${reply.text.slice(0, 100)}"]\n${messageText}`;
        }
        await channel.pushMessage(messageText, buildMeta(message, info.chatId, info.username));
    }
    async function handlePhotoMessage(message) {
        const info = await checkAccess(message);
        const photos = message.photo;
        if (!info || !photos || photos.length === 0) {
            return;
        }
        activeChats.add(info.chatId);
        startTyping(info.chatId);
        const largest = photos[photos.length - 1];
        const fileId = largest?.file_id;
        if (!fileId) {
            return;
        }
        let imagePath;
        let imageDataUri;
        try {
            imageDataUri = await downloadPhotoAsDataUri(fileId);
            imagePath = await downloadFile(fileId);
        }
        catch { }
        await channel.pushMessage(message.caption ?? "What's in this image?", buildMeta(message, info.chatId, info.username, {
            image_file_id: fileId,
            ...(imagePath ? { image_path: imagePath } : {}),
            ...(imageDataUri ? { image_data_uri: imageDataUri } : {}),
        }));
    }
    async function handleDocumentMessage(message) {
        const info = await checkAccess(message);
        const document = message.document;
        if (!info || !document?.file_id) {
            return;
        }
        activeChats.add(info.chatId);
        let filePath;
        try {
            filePath = await downloadFile(document.file_id, document.file_name);
        }
        catch { }
        await channel.pushMessage(message.caption ?? `[Document: ${document.file_name ?? "file"}]`, buildMeta(message, info.chatId, info.username, {
            document_file_id: document.file_id,
            document_name: document.file_name ?? "file",
            ...(filePath ? { file_path: filePath } : {}),
        }));
    }
    async function handleVoiceMessage(message) {
        const info = await checkAccess(message);
        const voice = message.voice ?? message.audio;
        if (!info || !voice?.file_id) {
            return;
        }
        activeChats.add(info.chatId);
        startTyping(info.chatId);
        let voicePath;
        let transcription;
        try {
            voicePath = await downloadFile(voice.file_id);
            transcription = await transcribeVoice(voicePath);
        }
        catch { }
        const text = transcription
            ? `[Voice]: ${transcription}`
            : "[Voice message received but transcription failed. Install whisper or configure GROQ_API_KEY.]";
        await channel.pushMessage(text, buildMeta(message, info.chatId, info.username, {
            voice_file_id: voice.file_id,
            ...(voice.duration !== undefined ? { voice_duration: String(voice.duration) } : {}),
            ...(voicePath ? { voice_path: voicePath } : {}),
        }));
    }
    async function handleStickerMessage(message) {
        const info = await checkAccess(message);
        const sticker = message.sticker;
        if (!info || !sticker) {
            return;
        }
        activeChats.add(info.chatId);
        await channel.pushMessage(`[Sticker: ${sticker.emoji ?? ""} from set "${sticker.set_name ?? "unknown"}"]`, buildMeta(message, info.chatId, info.username));
    }
    async function handleAnimationMessage(message) {
        const info = await checkAccess(message);
        const animation = message.animation;
        if (!info || !animation?.file_id) {
            return;
        }
        activeChats.add(info.chatId);
        await channel.pushMessage(message.caption ?? "[GIF/Animation received]", buildMeta(message, info.chatId, info.username, {
            animation_file_id: animation.file_id,
        }));
    }
    async function handleLocationMessage(message) {
        const info = await checkAccess(message);
        const location = message.location;
        if (!info || !location) {
            return;
        }
        activeChats.add(info.chatId);
        await channel.pushMessage(`[Location: ${location.latitude ?? 0}, ${location.longitude ?? 0}]`, buildMeta(message, info.chatId, info.username));
    }
    async function handleContactMessage(message) {
        const info = await checkAccess(message);
        const contact = message.contact;
        if (!info || !contact) {
            return;
        }
        activeChats.add(info.chatId);
        const name = [contact.first_name, contact.last_name].filter(Boolean).join(" ");
        await channel.pushMessage(`[Contact: ${name}, ${contact.phone_number ?? ""}]`, buildMeta(message, info.chatId, info.username));
    }
    async function handleIncomingMessage(message) {
        if (message.text?.startsWith("/")) {
            const handled = await handleCommand(message);
            if (handled) {
                return;
            }
        }
        if (message.text) {
            await handleTextMessage(message);
            return;
        }
        if (message.photo?.length) {
            await handlePhotoMessage(message);
            return;
        }
        if (message.document) {
            await handleDocumentMessage(message);
            return;
        }
        if (message.voice || message.audio) {
            await handleVoiceMessage(message);
            return;
        }
        if (message.sticker) {
            await handleStickerMessage(message);
            return;
        }
        if (message.animation) {
            await handleAnimationMessage(message);
            return;
        }
        if (message.location) {
            await handleLocationMessage(message);
            return;
        }
        if (message.contact) {
            await handleContactMessage(message);
        }
    }
    async function updateCallbackMessage(chatId, messageId, originalText, suffix) {
        try {
            await editMessageText(chatId, messageId, `${originalText}\n\n${suffix}`, {
                replyMarkup: { inline_keyboard: [] },
            });
        }
        catch { }
    }
    async function handleCallbackQuery(callbackQuery) {
        const data = callbackQuery.data ?? "";
        const callbackQueryId = callbackQuery.id;
        const message = callbackQuery.message;
        const chatId = message?.chat?.id !== undefined ? String(message.chat.id) : undefined;
        const messageId = message?.message_id;
        const originalText = message?.text ?? "Telegram action";
        if (callbackQueryId) {
            try {
                await answerCallbackQuery(callbackQueryId);
            }
            catch { }
        }
        if (!data) {
            return;
        }
        if (data.startsWith("perm:")) {
            const [, requestId, decision] = data.split(":");
            if (requestId && (decision === "allow" || decision === "deny")) {
                await channel.sendPermissionVerdict({ request_id: requestId, behavior: decision });
                pendingPermissions.delete(requestId);
                if (chatId && messageId !== undefined) {
                    await updateCallbackMessage(chatId, messageId, originalText, `${decision === "allow" ? "\u2705 Allowed" : "\u274c Denied"} by ${callbackQuery.from?.username ?? callbackQuery.from?.first_name ?? "user"}`);
                }
            }
            return;
        }
        if (data.startsWith("pair:")) {
            const actorId = callbackQuery.from?.id !== undefined ? String(callbackQuery.from.id) : "";
            if (!isAdmin(actorId)) {
                if (callbackQueryId) {
                    try {
                        await answerCallbackQuery(callbackQueryId, "Only admins can approve");
                    }
                    catch { }
                }
                return;
            }
            const [, pairingId, action] = data.split(":");
            const pairing = access.pending_pairings[pairingId];
            if (!pairing) {
                return;
            }
            if (action === "approve") {
                if (!access.dm.allowed_users.includes(pairing.user_id)) {
                    access.dm.allowed_users.push(pairing.user_id);
                }
                if (!access.group.allowed_users.includes(pairing.user_id)) {
                    access.group.allowed_users.push(pairing.user_id);
                }
                delete access.pending_pairings[pairingId];
                await saveAccess(accessPath, access);
                if (chatId && messageId !== undefined) {
                    await updateCallbackMessage(chatId, messageId, originalText, `\u2705 Approved @${pairing.username} (${pairing.user_id})`);
                }
                try {
                    await sendMessage(pairing.chat_id, "You've been approved! Send any message to start chatting.");
                }
                catch { }
            }
            return;
        }
        if (data.startsWith("cmd:")) {
            const command = data.slice(4);
            if (!chatId) {
                return;
            }
            switch (command) {
                case "status":
                    await sendMessage(chatId, `Connected. Active chats: ${activeChats.size}`);
                    return;
                case "help":
                    await sendMessage(chatId, "/start - Welcome\n/help - Commands\n/status - Status\n/stop - Interrupt\n/new - Fresh chat");
                    return;
                case "stop":
                    await channel.pushMessage("/stop", {
                        chat_id: chatId,
                        user: callbackQuery.from?.username ?? callbackQuery.from?.first_name ?? "user",
                    });
                    return;
                case "new":
                    await channel.pushMessage("/new", {
                        chat_id: chatId,
                        user: callbackQuery.from?.username ?? callbackQuery.from?.first_name ?? "user",
                    });
                    return;
                default:
                    return;
            }
        }
    }
    async function handleUpdate(update) {
        if (update.callback_query) {
            await handleCallbackQuery(update.callback_query);
            return;
        }
        if (update.message) {
            await handleIncomingMessage(update.message);
        }
    }
    const webhookServer = http.createServer((req, res) => {
        if (req.method !== "POST" || req.url !== webhookPath) {
            res.writeHead(404);
            res.end();
            return;
        }
        const secretHeader = req.headers["x-telegram-bot-api-secret-token"];
        const providedSecret = Array.isArray(secretHeader) ? secretHeader[0] : secretHeader;
        if (webhookSecret && !constantTimeEquals(webhookSecret, providedSecret ?? "")) {
            res.writeHead(401);
            res.end("Invalid secret");
            return;
        }
        const chunks = [];
        req.on("data", (chunk) => chunks.push(chunk));
        req.on("end", () => {
            let update;
            try {
                update = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
            }
            catch (error) {
                process.stderr.write(`[telegram] Webhook parse error: ${error.message}\n`);
                res.writeHead(400);
                res.end("Bad request");
                return;
            }
            res.writeHead(200);
            res.end("OK");
            void handleUpdate(update).catch((error) => {
                process.stderr.write(`[telegram] Webhook handler error: ${error.message}\n`);
            });
        });
    });
    channel.onReply(async (chatId, text) => {
        stopTyping(chatId);
        await clearStreamingStatus(chatId);
        await sendTextResponse(chatId, text);
    });
    channel.onPermissionRequest(async (req) => {
        const targetChats = [...activeChats];
        if (targetChats.length === 0) {
            process.stderr.write("[telegram] No target chats for permission prompt\n");
            return;
        }
        const keyboard = {
            inline_keyboard: [[
                    { text: "\u2705 Allow", callback_data: `perm:${req.request_id}:allow` },
                    { text: "\u274c Deny", callback_data: `perm:${req.request_id}:deny` },
                ]],
        };
        const message = [
            "<b>\ud83d\udd10 Permission Request</b>",
            "",
            `<b>Tool:</b> <code>${escapeHtml(req.tool_name)}</code>`,
            `<b>Description:</b> ${escapeHtml(req.description)}`,
            "",
            `<pre>${escapeHtml(req.input_preview.slice(0, 2000))}</pre>`,
        ].join("\n");
        for (const chatId of targetChats) {
            try {
                await sendMessage(chatId, message, {
                    parseMode: "HTML",
                    replyMarkup: keyboard,
                });
                pendingPermissions.set(req.request_id, { chatId });
            }
            catch (error) {
                process.stderr.write(`[telegram] Permission prompt error: ${error.message}\n`);
            }
        }
    });
    channel.onToolCall(async (name, args) => {
        switch (name) {
            case "telegram_send": {
                const chatId = String(args.chat_id ?? "");
                const text = String(args.text ?? "");
                const replyTo = args.reply_to ? parseInt(String(args.reply_to), 10) : undefined;
                const parseMode = args.parse_mode === "html" ? "HTML" : undefined;
                const files = Array.isArray(args.files) ? args.files.map((entry) => String(entry)) : undefined;
                const rawButtons = Array.isArray(args.buttons)
                    ? args.buttons
                    : undefined;
                const replyMarkup = rawButtons && rawButtons.length > 0
                    ? {
                        inline_keyboard: [rawButtons.map((button) => ({
                                text: String(button.text ?? ""),
                                callback_data: String(button.callback_data ?? ""),
                            }))],
                    }
                    : undefined;
                if (files && files.length > 0) {
                    for (const filePath of files) {
                        try {
                            if (isImagePath(filePath)) {
                                await sendPhoto(chatId, filePath, text, { parseMode, replyTo, replyMarkup });
                            }
                            else {
                                await sendDocument(chatId, filePath, text, { parseMode, replyTo, replyMarkup });
                            }
                        }
                        catch (error) {
                            process.stderr.write(`[telegram] File send error: ${error.message}\n`);
                        }
                    }
                    return { ok: true, sent: files.length };
                }
                const chunks = chunkText(parseMode === "HTML" ? text : text, MAX_MSG_LEN);
                const sentIds = [];
                for (const chunk of chunks) {
                    const msg = await sendMessage(chatId, chunk, {
                        parseMode,
                        replyTo,
                        replyMarkup,
                    });
                    if (msg.message_id !== undefined) {
                        sentIds.push(msg.message_id);
                    }
                }
                return { ok: true, message_ids: sentIds };
            }
            case "telegram_react": {
                const chatId = String(args.chat_id ?? "");
                const messageId = parseInt(String(args.message_id ?? "0"), 10);
                const emoji = String(args.emoji ?? "");
                await setMessageReaction(chatId, messageId, emoji);
                return { ok: true };
            }
            case "telegram_edit": {
                const chatId = String(args.chat_id ?? "");
                const messageId = parseInt(String(args.message_id ?? "0"), 10);
                const text = String(args.text ?? "");
                const parseMode = args.parse_mode === "html" ? "HTML" : undefined;
                await editMessageText(chatId, messageId, text, { parseMode });
                return { ok: true };
            }
            case "telegram_poll": {
                const chatId = String(args.chat_id ?? "");
                const question = String(args.question ?? "");
                let rawOptions = args.options;
                if (typeof rawOptions === "string") {
                    try {
                        rawOptions = JSON.parse(rawOptions);
                    }
                    catch {
                        rawOptions = [rawOptions];
                    }
                }
                const options = Array.isArray(rawOptions) ? rawOptions.map((entry) => String(entry)) : [];
                const allowMultiple = Boolean(args.allow_multiple);
                const isAnonymous = args.is_anonymous === undefined ? true : Boolean(args.is_anonymous);
                const result = await sendPoll(chatId, question, options, allowMultiple, isAnonymous);
                return { ok: true, message_id: result.message_id };
            }
            case "telegram_download": {
                const fileId = String(args.file_id ?? "");
                const filename = args.filename ? String(args.filename) : undefined;
                const path = await downloadFile(fileId, filename);
                return { ok: true, path };
            }
            default:
                throw new Error(`Unknown tool: ${name}`);
        }
    });
    channel.onHookEvent(async (input) => {
        if (input.hook_event_name === "PreToolUse" && "tool_name" in input) {
            for (const chatId of activeChats) {
                await updateStreamingStatus(chatId, input.tool_name);
            }
        }
        if (input.hook_event_name === "SessionEnd") {
            for (const chatId of activeChats) {
                stopTyping(chatId);
                await clearStreamingStatus(chatId);
            }
        }
        if (input.hook_event_name === "Notification" && "message" in input) {
            for (const chatId of activeChats) {
                try {
                    await sendMessage(chatId, `\u2139\ufe0f ${String(input.message)}`);
                }
                catch { }
            }
        }
        return {};
    });
    try {
        const me = await getMe();
        botUsername = me.username ?? "";
        await setMyCommands([
            { command: "start", description: "Welcome message" },
            { command: "help", description: "Show commands" },
            { command: "status", description: "Connection status" },
            { command: "stop", description: "Interrupt current task" },
            { command: "new", description: "Clear conversation" },
            { command: "streaming", description: "Toggle live status updates" },
            { command: "approve", description: "Approve pairing (admin)" },
        ]);
    }
    catch (error) {
        process.stderr.write(`[telegram] Failed to initialize bot metadata: ${error.message}\n`);
    }
    await new Promise((resolve) => {
        webhookServer.listen(webhookPort, webhookHost, () => {
            process.stderr.write(`[telegram] Webhook server listening on http://${webhookHost}:${webhookPort}${webhookPath}\n`);
            resolve();
        });
    });
    if (cfg.webhookUrl) {
        try {
            await setWebhook(cfg.webhookUrl, webhookSecret);
            webhookRegistered = true;
            process.stderr.write(`[telegram] Webhook registered: ${cfg.webhookUrl}\n`);
        }
        catch (error) {
            process.stderr.write(`[telegram] Failed to register webhook: ${error.message}\n`);
        }
    }
    else {
        process.stderr.write(`[telegram] TELEGRAM_WEBHOOK_URL not set; server is listening but webhook registration was skipped\n`);
    }
    process.stderr.write(`[telegram] Webhook mode ready (@${botUsername || "unknown"})\n`);
    process.stderr.write(`[telegram] DM policy: ${access.dm.policy}, Group policy: ${access.group.policy}\n`);
    process.stderr.write(`[telegram] Allowed DM users: ${access.dm.allowed_users.length}, Admins: ${access.dm.admin_users.length}\n`);
    const cleanup = () => {
        if (shuttingDown) {
            return;
        }
        shuttingDown = true;
        for (const interval of typingIntervals.values()) {
            clearInterval(interval);
        }
        typingIntervals.clear();
        webhookServer.close();
        if (webhookRegistered) {
            void deleteWebhook().catch(() => { });
        }
        channel.cleanup();
    };
    return { channel, cleanup };
}
//# sourceMappingURL=telegram.js.map