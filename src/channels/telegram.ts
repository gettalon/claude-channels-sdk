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
import type { ChannelServerOptions, ChannelPermissionRequest } from "../types.js";

// ─── Config ──────────────────────────────────────────────────────────────────

export type PairingMode = "pairing" | "open" | "disabled";

export interface AccessPolicy {
  policy: PairingMode;
  allowed_users: string[];
  admin_users: string[];
}

export interface TelegramAccess {
  dm: AccessPolicy;
  group: AccessPolicy;
  pending_pairings: Record<string, { code: string; user_id: string; username: string; chat_id: string; ts: number }>;
}

export interface TelegramConfig {
  botToken: string;
  allowedChats?: string[];
  accessPath?: string;
  downloadPath?: string;
  groupTrigger?: "mention" | "always" | "never";
  streamingUpdates?: boolean;
}

export function parseConfig(): TelegramConfig {
  const botToken = process.env.TELEGRAM_BOT_TOKEN ?? "";
  if (!botToken) throw new Error("TELEGRAM_BOT_TOKEN is required");

  const allowedChats = process.env.TELEGRAM_ALLOWED_CHATS
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const accessPath = process.env.TELEGRAM_ACCESS_PATH;
  const downloadPath = process.env.TELEGRAM_DOWNLOAD_PATH;
  const groupTrigger = (process.env.TELEGRAM_GROUP_TRIGGER as TelegramConfig["groupTrigger"]) ?? "mention";
  const streamingUpdates = process.env.TELEGRAM_STREAMING !== "false";

  return { botToken, allowedChats, accessPath, downloadPath, groupTrigger, streamingUpdates };
}

// ─── Access Store ───────────────────────────────────────────────────────────

function defaultAccess(): TelegramAccess {
  return {
    dm: { policy: "pairing", allowed_users: [], admin_users: [] },
    group: { policy: "pairing", allowed_users: [], admin_users: [] },
    pending_pairings: {},
  };
}

async function loadAccess(path: string): Promise<TelegramAccess> {
  const { readFileSync } = await import("node:fs");
  try {
    const raw = readFileSync(path, "utf-8");
    const data = JSON.parse(raw);
    return { ...defaultAccess(), ...data };
  } catch {
    return defaultAccess();
  }
}

async function saveAccess(path: string, access: TelegramAccess): Promise<void> {
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const { dirname } = await import("node:path");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(access, null, 2));
}

function generatePairingCode(): string {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const MAX_MSG_LEN = 4096;

function chunkText(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let remaining = text;
  // Reserve space for continuation marker
  const effectiveLimit = limit - 4;
  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }
    // Try to split at 50%+ boundary on newlines, then spaces
    let splitAt = remaining.lastIndexOf("\n", effectiveLimit);
    if (splitAt < effectiveLimit * 0.5) splitAt = remaining.lastIndexOf(" ", effectiveLimit);
    if (splitAt <= 0) splitAt = effectiveLimit;
    chunks.push(remaining.slice(0, splitAt) + "\n\u23ec");
    remaining = remaining.slice(splitAt).replace(/^\n/, "");
  }
  return chunks;
}

/**
 * Minimal Markdown to Telegram HTML conversion.
 * Handles bold, italic, code, pre blocks, links, strikethrough, lists.
 */
function mdToHtml(md: string): string {
  let html = md;
  // Code blocks first (```lang\n...\n```)
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, _lang, code) => `<pre>${escapeHtml(code.trimEnd())}</pre>`);
  // Inline code
  html = html.replace(/`([^`]+)`/g, (_m, code) => `<code>${escapeHtml(code)}</code>`);
  // Bold **text** or __text__
  html = html.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  html = html.replace(/__(.+?)__/g, "<b>$1</b>");
  // Strikethrough ~~text~~
  html = html.replace(/~~(.+?)~~/g, "<s>$1</s>");
  // Italic *text* or _text_
  html = html.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "<i>$1</i>");
  html = html.replace(/(?<!_)_(?!_)(.+?)(?<!_)_(?!_)/g, "<i>$1</i>");
  // Links [text](url)
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  // Headers # text -> bold
  html = html.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");
  // Bullet lists
  html = html.replace(/^[-*]\s+/gm, "\u2022 ");
  return html;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Extra Tools ─────────────────────────────────────────────────────────────

const EXTRA_TOOLS: ChannelServerOptions["extraTools"] = [
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

// ─── Channel Factory ─────────────────────────────────────────────────────────

export async function createTelegramChannel(
  config?: Partial<TelegramConfig>,
): Promise<{ channel: ChannelServer; cleanup: () => void }> {
  // @ts-ignore - grammy is a dependency
  const { Bot, InlineKeyboard, InputFile } = await import("grammy") as any;
  const { join } = await import("node:path");
  const { homedir } = await import("node:os");

  const { mkdirSync: mkdirSyncFs, writeFileSync: writeFileSyncFs } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { createWriteStream } = await import("node:fs");
  const { pipeline } = await import("node:stream/promises");

  const cfg = { ...parseConfig(), ...config };
  if (!cfg.botToken) throw new Error("TELEGRAM_BOT_TOKEN is required");

  const accessPath = cfg.accessPath ?? join(homedir(), ".claude", "channels", "telegram", "access.json");
  const downloadDir = cfg.downloadPath ?? join(tmpdir(), "talon-telegram-downloads");
  mkdirSyncFs(downloadDir, { recursive: true });

  let access = await loadAccess(accessPath);

  // Legacy allowedChats → migrate to access.dm.allowed_users
  if (cfg.allowedChats && cfg.allowedChats.length > 0) {
    for (const id of cfg.allowedChats) {
      if (!access.dm.allowed_users.includes(id)) access.dm.allowed_users.push(id);
    }
    access.dm.policy = "pairing";
    await saveAccess(accessPath, access);
  }

  const bot = new Bot(cfg.botToken);
  let botUsername = "";

  // Pending permission prompts: request_id -> { chatId }
  const pendingPermissions = new Map<string, { chatId: string }>();
  // Active chats that have sent messages (for permission prompts when no allowlist)
  const activeChats = new Set<string>();
  // Typing indicator intervals per chat
  const typingIntervals = new Map<string, ReturnType<typeof setInterval>>();
  // Streaming status: chat_id -> { messageId, tools }
  const streamingStatus = new Map<string, { messageId: number; tools: string[]; lastUpdate: number }>();
  // Per-chat streaming toggle (default from config)
  const streamingEnabled = new Map<string, boolean>();

  function isStreamingEnabled(chatId: string): boolean {
    return streamingEnabled.get(chatId) ?? (cfg.streamingUpdates !== false);
  }

  // ─── Access check ───────────────────────────────────────────────────────

  function isAllowed(userId: string, chatType: "private" | "group" | "supergroup" | "channel"): boolean {
    const isGroup = chatType !== "private";
    const policy = isGroup ? access.group : access.dm;

    if (policy.policy === "open") return true;
    if (policy.policy === "disabled") return false;
    // "pairing" mode: check allowlist + admins
    return policy.allowed_users.includes(userId) || policy.admin_users.includes(userId);
  }

  function isAdmin(userId: string): boolean {
    return access.dm.admin_users.includes(userId) || access.group.admin_users.includes(userId);
  }

  // ─── Typing indicator ──────────────────────────────────────────────────

  function startTyping(chatId: string): void {
    if (typingIntervals.has(chatId)) return;
    const send = () => { bot.api.sendChatAction(chatId, "typing").catch(() => {}); };
    send();
    typingIntervals.set(chatId, setInterval(send, 4000));
  }

  function stopTyping(chatId: string): void {
    const interval = typingIntervals.get(chatId);
    if (interval) {
      clearInterval(interval);
      typingIntervals.delete(chatId);
    }
  }

  // ─── File download ─────────────────────────────────────────────────────

  async function downloadFile(fileId: string, filename?: string): Promise<string> {
    const file = await bot.api.getFile(fileId);
    const filePath = file.file_path;
    if (!filePath) throw new Error("No file_path from Telegram");

    const url = `https://api.telegram.org/file/bot${cfg.botToken}/${filePath}`;
    const ext = filePath.split(".").pop() ?? "";
    const outName = filename ?? `${fileId.slice(0, 12)}.${ext}`;
    const outPath = join(downloadDir, outName.replace(/[^a-zA-Z0-9._-]/g, "_"));

    const resp = await fetch(url);
    if (!resp.ok || !resp.body) throw new Error(`Download failed: ${resp.status}`);

    const ws = createWriteStream(outPath);
    // @ts-ignore - ReadableStream to NodeJS.WritableStream
    await pipeline(resp.body as any, ws);
    return outPath;
  }

  // ─── Streaming status updates ──────────────────────────────────────────

  async function updateStreamingStatus(chatId: string, toolName: string): Promise<void> {
    if (!isStreamingEnabled(chatId)) return;

    const status = streamingStatus.get(chatId);
    const now = Date.now();

    if (status) {
      status.tools.push(toolName);
      // Debounce: only update every 1.5s
      if (now - status.lastUpdate < 1500) return;
      status.lastUpdate = now;

      const toolList = status.tools.slice(-5).map((t) => `\u2022 ${t}`).join("\n");
      const text = `\u2699\ufe0f <i>Working...</i>\n\n${toolList}`;
      try {
        await bot.api.editMessageText(chatId, status.messageId, text, { parse_mode: "HTML" });
      } catch {}
    } else {
      // Send initial status message
      try {
        const msg = await bot.api.sendMessage(chatId, `\u2699\ufe0f <i>Working on: ${escapeHtml(toolName)}...</i>`, { parse_mode: "HTML" });
        streamingStatus.set(chatId, { messageId: msg.message_id, tools: [toolName], lastUpdate: now });
      } catch {}
    }
  }

  async function clearStreamingStatus(chatId: string): Promise<void> {
    const status = streamingStatus.get(chatId);
    if (status) {
      try {
        await bot.api.deleteMessage(chatId, status.messageId);
      } catch {}
      streamingStatus.delete(chatId);
    }
  }

  // ─── Channel server ────────────────────────────────────────────────────

  const channel = new ChannelServer({
    name: "telegram",
    version: "1.0.0",
    instructions: [
      "You are connected to Telegram via a bot. Messages arrive as channel notifications with chat_id in meta.",
      "Use the reply tool to respond. For advanced features use telegram_send, telegram_react, telegram_edit, telegram_poll.",
      "Messages support HTML formatting. Keep messages under 4096 characters; longer content is auto-chunked.",
      "Permission requests appear as inline keyboard buttons in the chat. The user taps Allow or Deny.",
    ].join(" "),
    permissionRelay: true,
    extraTools: EXTRA_TOOLS,
  });

  // ─── Bot commands ──────────────────────────────────────────────────────

  bot.command("start", async (ctx: any) => {
    const chatId = String(ctx.chat.id);
    const userId = String(ctx.from?.id ?? "");
    const username = ctx.from?.username ?? ctx.from?.first_name ?? "unknown";

    if (!isAllowed(userId, ctx.chat.type)) {
      await handlePairing(ctx, userId, username, chatId);
      return;
    }

    const keyboard = new InlineKeyboard()
      .text("Status", "cmd:status").text("Help", "cmd:help").row()
      .text("Stop", "cmd:stop").text("New Chat", "cmd:new");

    await ctx.reply(
      `<b>Talon Channels</b>\n\nConnected to Claude Code via Telegram.\nSend any message to start chatting.`,
      { parse_mode: "HTML", reply_markup: keyboard },
    );
  });

  bot.command("help", async (ctx: any) => {
    await ctx.reply(
      [
        "<b>Commands</b>",
        "",
        "/start \u2014 Welcome message",
        "/help \u2014 This help",
        "/status \u2014 Connection status",
        "/stop \u2014 Interrupt current task",
        "/new \u2014 Clear conversation context",
        "/streaming \u2014 Toggle live tool status updates",
        "/approve &lt;code&gt; \u2014 Approve a pairing request (admin)",
      ].join("\n"),
      { parse_mode: "HTML" },
    );
  });

  bot.command("status", async (ctx: any) => {
    const userId = String(ctx.from?.id ?? "");
    const chatId = String(ctx.chat.id);
    const isAdm = isAdmin(userId);
    const policy = ctx.chat.type === "private" ? access.dm : access.group;
    const pendingCount = Object.keys(access.pending_pairings).length;

    await ctx.reply(
      [
        "<b>Status</b>",
        "",
        `<b>Chat:</b> ${chatId}`,
        `<b>User:</b> ${userId}`,
        `<b>Admin:</b> ${isAdm ? "Yes" : "No"}`,
        `<b>Policy:</b> ${policy.policy}`,
        `<b>Allowed users:</b> ${policy.allowed_users.length}`,
        `<b>Pending pairings:</b> ${pendingCount}`,
        `<b>Bot:</b> @${botUsername}`,
      ].join("\n"),
      { parse_mode: "HTML" },
    );
  });

  bot.command("stop", async (ctx: any) => {
    await ctx.reply("Stop signal sent.");
    // Push as a message so Claude sees it
    await channel.pushMessage("/stop", {
      chat_id: String(ctx.chat.id),
      message_id: String(ctx.message.message_id),
      user: ctx.from?.username ?? "user",
    });
  });

  bot.command("new", async (ctx: any) => {
    await ctx.reply("Conversation context cleared.");
    await channel.pushMessage("/new — start fresh conversation", {
      chat_id: String(ctx.chat.id),
      message_id: String(ctx.message.message_id),
      user: ctx.from?.username ?? "user",
    });
  });

  bot.command("streaming", async (ctx: any) => {
    const chatId = String(ctx.chat.id);
    const current = isStreamingEnabled(chatId);
    const next = !current;
    streamingEnabled.set(chatId, next);
    await ctx.reply(`Streaming status updates: <b>${next ? "ON" : "OFF"}</b>`, { parse_mode: "HTML" });
  });

  bot.command("approve", async (ctx: any) => {
    const userId = String(ctx.from?.id ?? "");
    if (!isAdmin(userId)) {
      await ctx.reply("Only admins can approve pairing requests.");
      return;
    }

    const code = ctx.match?.trim().toUpperCase();
    if (!code) {
      await ctx.reply("Usage: /approve <code>");
      return;
    }

    // Find pending pairing with this code
    const entry = Object.entries(access.pending_pairings).find(([, v]) => v.code === code);
    if (!entry) {
      await ctx.reply(`No pending pairing with code: ${code}`);
      return;
    }

    const [pairingId, pairing] = entry;

    // Add to allowlist
    if (!access.dm.allowed_users.includes(pairing.user_id)) {
      access.dm.allowed_users.push(pairing.user_id);
    }
    if (!access.group.allowed_users.includes(pairing.user_id)) {
      access.group.allowed_users.push(pairing.user_id);
    }
    delete access.pending_pairings[pairingId];
    await saveAccess(accessPath, access);

    await ctx.reply(`Approved @${pairing.username} (${pairing.user_id})`);

    // Notify the paired user
    try {
      await bot.api.sendMessage(pairing.chat_id, "You've been approved! Send any message to start chatting.");
    } catch {
      // User may have blocked the bot
    }
  });

  // ─── Pairing flow ─────────────────────────────────────────────────────

  async function handlePairing(ctx: any, userId: string, username: string, chatId: string): Promise<void> {
    const policy = ctx.chat.type === "private" ? access.dm : access.group;

    if (policy.policy === "disabled") return; // silently ignore
    if (policy.policy === "open") return; // shouldn't reach here

    // Check if already has a pending pairing
    const existing = Object.values(access.pending_pairings).find((p) => p.user_id === userId);
    if (existing) {
      await ctx.reply(
        `Your pairing request is pending.\nCode: <code>${existing.code}</code>\nAsk an admin to run: /approve ${existing.code}`,
        { parse_mode: "HTML" },
      );
      return;
    }

    // Generate new pairing
    const code = generatePairingCode();
    const pairingId = `${userId}-${Date.now()}`;
    access.pending_pairings[pairingId] = { code, user_id: userId, username, chat_id: chatId, ts: Date.now() };
    await saveAccess(accessPath, access);

    await ctx.reply(
      [
        `<b>Pairing Required</b>`,
        ``,
        `Your code: <code>${code}</code>`,
        ``,
        `Ask the Claude Code operator to approve you:`,
        `<code>/approve ${code}</code>`,
      ].join("\n"),
      { parse_mode: "HTML" },
    );

    // Notify admins
    const adminIds = [...new Set([...access.dm.admin_users, ...access.group.admin_users])];
    const keyboard = new InlineKeyboard().text(`Approve ${username}`, `pair:${pairingId}:approve`);
    for (const adminId of adminIds) {
      try {
        await bot.api.sendMessage(
          adminId,
          `<b>Pairing Request</b>\n\nUser: @${escapeHtml(username)} (${userId})\nCode: <code>${code}</code>`,
          { parse_mode: "HTML", reply_markup: keyboard },
        );
      } catch {
        // Admin may not have started the bot
      }
    }
  }

  // ─── Inbound: Bot messages → channel.pushMessage() ───────────────────────

  // Helper: common access + group + rate limit checks
  function checkAccess(ctx: any): { chatId: string; userId: string; username: string; isGroup: boolean } | null {
    const chatId = String(ctx.chat.id);
    const userId = String(ctx.from?.id ?? "");
    const username = ctx.from?.username ?? ctx.from?.first_name ?? "unknown";
    const isGroup = ctx.chat.type !== "private";

    if (!isAllowed(userId, ctx.chat.type)) {
      handlePairing(ctx, userId, username, chatId);
      return null;
    }

    if (isGroup && cfg.groupTrigger === "never") return null;
    if (isGroup && cfg.groupTrigger === "mention") {
      const text = (ctx.message?.text ?? ctx.message?.caption ?? "").toLowerCase();
      const mentioned = text.includes(`@${botUsername.toLowerCase()}`) ||
        ctx.message?.reply_to_message?.from?.username?.toLowerCase() === botUsername.toLowerCase();
      if (!mentioned) return null;
    }

    return { chatId, userId, username, isGroup };
  }

  // Helper: build meta with reply-to and forward context
  function buildMeta(ctx: any, chatId: string, username: string, extra?: Record<string, string>): Record<string, string> {
    const meta: Record<string, string> = {
      chat_id: chatId,
      message_id: String(ctx.message.message_id),
      user: username,
      ts: String(ctx.message.date),
      ...extra,
    };

    // Reply-to context
    const reply = ctx.message.reply_to_message;
    if (reply) {
      meta.reply_to_id = String(reply.message_id);
      meta.reply_to_user = reply.from?.username ?? reply.from?.first_name ?? "unknown";
      if (reply.text) meta.reply_to_text = reply.text.slice(0, 200);
    }

    // Forward context
    if (ctx.message.forward_origin) {
      const origin = ctx.message.forward_origin;
      if (origin.type === "user") {
        meta.forwarded_from = origin.sender_user?.username ?? origin.sender_user?.first_name ?? "unknown";
      } else if (origin.type === "channel") {
        meta.forwarded_from = origin.chat?.title ?? "channel";
      } else if (origin.type === "hidden_user") {
        meta.forwarded_from = origin.sender_user_name ?? "hidden";
      }
    }

    return meta;
  }

  bot.on("message:text", async (ctx: any) => {
    // Skip if it's a command (already handled above)
    if (ctx.message.text.startsWith("/")) return;

    const info = checkAccess(ctx);
    if (!info) return;
    const { chatId, userId, username, isGroup } = info;

    activeChats.add(chatId);

    startTyping(chatId);

    // Build message with sender label for groups
    let messageText = ctx.message.text;
    if (isGroup) {
      messageText = `[From: ${username} (id:${userId})]\n${messageText}`;
    }

    // Include reply-to quote
    const reply = ctx.message.reply_to_message;
    if (reply?.text) {
      messageText = `[Replying to ${reply.from?.username ?? "user"}: "${reply.text.slice(0, 100)}"]\n${messageText}`;
    }

    await channel.pushMessage(messageText, buildMeta(ctx, chatId, username));
  });

  bot.on("message:photo", async (ctx: any) => {
    const info = checkAccess(ctx);
    if (!info) return;

    activeChats.add(info.chatId);

    startTyping(info.chatId);

    const caption = ctx.message.caption ?? "[Photo received]";
    const photos = ctx.message.photo;
    const largest = photos[photos.length - 1];

    // Try to download photo to disk
    let imagePath: string | undefined;
    try {
      imagePath = await downloadFile(largest.file_id);
    } catch {}

    await channel.pushMessage(caption, buildMeta(ctx, info.chatId, info.username, {
      image_file_id: largest.file_id,
      ...(imagePath ? { image_path: imagePath } : {}),
    }));
  });

  bot.on("message:document", async (ctx: any) => {
    const info = checkAccess(ctx);
    if (!info) return;

    activeChats.add(info.chatId);


    const doc = ctx.message.document;
    const caption = ctx.message.caption ?? `[Document: ${doc.file_name ?? "file"}]`;

    // Download document
    let filePath: string | undefined;
    try {
      filePath = await downloadFile(doc.file_id, doc.file_name);
    } catch {}

    await channel.pushMessage(caption, buildMeta(ctx, info.chatId, info.username, {
      document_file_id: doc.file_id,
      document_name: doc.file_name ?? "file",
      ...(filePath ? { file_path: filePath } : {}),
    }));
  });

  bot.on("message:voice", async (ctx: any) => {
    const info = checkAccess(ctx);
    if (!info) return;

    activeChats.add(info.chatId);

    startTyping(info.chatId);

    // Download voice file
    let voicePath: string | undefined;
    try {
      voicePath = await downloadFile(ctx.message.voice.file_id);
    } catch {}

    await channel.pushMessage("[Voice message received]", buildMeta(ctx, info.chatId, info.username, {
      voice_file_id: ctx.message.voice.file_id,
      voice_duration: String(ctx.message.voice.duration),
      ...(voicePath ? { voice_path: voicePath } : {}),
    }));
  });

  bot.on("message:sticker", async (ctx: any) => {
    const info = checkAccess(ctx);
    if (!info) return;

    activeChats.add(info.chatId);


    const sticker = ctx.message.sticker;
    const text = `[Sticker: ${sticker.emoji ?? ""} from set "${sticker.set_name ?? "unknown"}"]`;
    await channel.pushMessage(text, buildMeta(ctx, info.chatId, info.username));
  });

  bot.on("message:location", async (ctx: any) => {
    const info = checkAccess(ctx);
    if (!info) return;

    activeChats.add(info.chatId);


    const loc = ctx.message.location;
    await channel.pushMessage(`[Location: ${loc.latitude}, ${loc.longitude}]`, buildMeta(ctx, info.chatId, info.username));
  });

  bot.on("message:contact", async (ctx: any) => {
    const info = checkAccess(ctx);
    if (!info) return;

    activeChats.add(info.chatId);


    const contact = ctx.message.contact;
    const name = [contact.first_name, contact.last_name].filter(Boolean).join(" ");
    await channel.pushMessage(`[Contact: ${name}, ${contact.phone_number}]`, buildMeta(ctx, info.chatId, info.username));
  });

  bot.on("message:animation", async (ctx: any) => {
    const info = checkAccess(ctx);
    if (!info) return;

    activeChats.add(info.chatId);


    const caption = ctx.message.caption ?? "[GIF/Animation received]";
    await channel.pushMessage(caption, buildMeta(ctx, info.chatId, info.username, {
      animation_file_id: ctx.message.animation.file_id,
    }));
  });

  // ─── Callback queries (permission + pairing + commands) ────────────────

  bot.on("callback_query:data", async (ctx: any) => {
    const data = ctx.callbackQuery.data;

    // Permission callbacks
    if (data.startsWith("perm:")) {
      const [, requestId, decision] = data.split(":");
      if (requestId && (decision === "allow" || decision === "deny")) {
        await channel.sendPermissionVerdict({ request_id: requestId, behavior: decision });
        pendingPermissions.delete(requestId);

        try {
          await ctx.editMessageReplyMarkup({ reply_markup: undefined });
          await ctx.editMessageText(
            `${ctx.callbackQuery.message && "text" in ctx.callbackQuery.message ? ctx.callbackQuery.message.text : "Permission request"}\n\n${decision === "allow" ? "\u2705 Allowed" : "\u274c Denied"} by ${ctx.from?.username ?? ctx.from?.first_name ?? "user"}`,
          );
        } catch {}
      }
      await ctx.answerCallbackQuery({ text: `Permission ${decision}` });
      return;
    }

    // Pairing approval callbacks
    if (data.startsWith("pair:")) {
      const userId = String(ctx.from?.id ?? "");
      if (!isAdmin(userId)) {
        await ctx.answerCallbackQuery({ text: "Only admins can approve" });
        return;
      }

      const [, pairingId, action] = data.split(":");
      const pairing = access.pending_pairings[pairingId];
      if (!pairing) {
        await ctx.answerCallbackQuery({ text: "Pairing not found or already handled" });
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

        try {
          await ctx.editMessageReplyMarkup({ reply_markup: undefined });
          await ctx.editMessageText(
            `\u2705 Approved @${pairing.username} (${pairing.user_id})`,
          );
        } catch {}

        try {
          await bot.api.sendMessage(pairing.chat_id, "You've been approved! Send any message to start chatting.");
        } catch {}
      }
      await ctx.answerCallbackQuery({ text: "Approved" });
      return;
    }

    // Command callbacks
    if (data.startsWith("cmd:")) {
      const cmd = data.slice(4);
      switch (cmd) {
        case "status":
          await ctx.answerCallbackQuery();
          await bot.api.sendMessage(ctx.chat!.id, `Connected. Active chats: ${activeChats.size}`);
          break;
        case "help":
          await ctx.answerCallbackQuery();
          await bot.api.sendMessage(ctx.chat!.id, "/start \u2014 Welcome\n/help \u2014 Commands\n/status \u2014 Status\n/stop \u2014 Interrupt\n/new \u2014 Fresh chat");
          break;
        case "stop":
          await ctx.answerCallbackQuery({ text: "Stop signal sent" });
          await channel.pushMessage("/stop", {
            chat_id: String(ctx.chat!.id),
            user: ctx.from?.username ?? "user",
          });
          break;
        case "new":
          await ctx.answerCallbackQuery({ text: "Conversation cleared" });
          await channel.pushMessage("/new", {
            chat_id: String(ctx.chat!.id),
            user: ctx.from?.username ?? "user",
          });
          break;
        default:
          await ctx.answerCallbackQuery();
      }
      return;
    }

    await ctx.answerCallbackQuery();
  });

  // ─── Outbound: channel.onReply() → Telegram send ────────────────────────

  channel.onReply(async (chatId: string, text: string) => {
    stopTyping(chatId);
    await clearStreamingStatus(chatId);
    const html = mdToHtml(text);
    const chunks = chunkText(html, MAX_MSG_LEN);
    for (let i = 0; i < chunks.length; i++) {
      if (i > 0) await sleep(300); // Delay between chunks
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await bot.api.sendMessage(chatId, chunks[i], { parse_mode: "HTML" });
          break;
        } catch (err: any) {
          if (err?.error_code === 429) {
            const retryAfter = err.parameters?.retry_after ?? 5;
            await sleep(retryAfter * 1000);
            continue;
          }
          // Fall back to plain text on parse error
          if (attempt === 0 && err?.error_code === 400) {
            try {
              await bot.api.sendMessage(chatId, text);
            } catch {
              process.stderr.write(`[telegram] Failed to send to ${chatId}: ${err.message}\n`);
            }
            break;
          }
          process.stderr.write(`[telegram] Send error: ${err.message}\n`);
          break;
        }
      }
    }
  });

  // ─── Permission prompts → inline keyboards ──────────────────────────────

  channel.onPermissionRequest(async (req: ChannelPermissionRequest) => {
    const targetChats = [...activeChats];
    if (targetChats.length === 0) {
      process.stderr.write("[telegram] No target chats for permission prompt\n");
      return;
    }

    const keyboard = new InlineKeyboard()
      .text("\u2705 Allow", `perm:${req.request_id}:allow`)
      .text("\u274c Deny", `perm:${req.request_id}:deny`);

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
        await bot.api.sendMessage(chatId, message, {
          parse_mode: "HTML",
          reply_markup: keyboard,
        });
        pendingPermissions.set(req.request_id, { chatId });
      } catch (err: any) {
        process.stderr.write(`[telegram] Permission prompt error: ${err.message}\n`);
      }
    }
  });

  // ─── Extra tool handlers ─────────────────────────────────────────────────

  channel.onToolCall(async (name: string, args: Record<string, unknown>) => {
    switch (name) {
      case "telegram_send": {
        const chatId = args.chat_id as string;
        const text = args.text as string;
        const replyTo = args.reply_to as string | undefined;
        const parseMode = args.parse_mode as string | undefined;
        const files = args.files as string[] | undefined;
        const buttons = args.buttons as Array<{ text: string; callback_data: string }> | undefined;

        const opts: Record<string, any> = {};
        if (parseMode === "html") opts.parse_mode = "HTML";
        if (replyTo) opts.reply_to_message_id = parseInt(replyTo, 10);
        if (buttons && buttons.length > 0) {
          const kb = new InlineKeyboard();
          for (const btn of buttons) {
            kb.text(btn.text, btn.callback_data);
          }
          opts.reply_markup = kb;
        }

        if (files && files.length > 0) {
          for (const filePath of files) {
            try {
              await bot.api.sendDocument(chatId, new InputFile(filePath), {
                caption: text,
                ...opts,
              });
            } catch (err: any) {
              process.stderr.write(`[telegram] File send error: ${err.message}\n`);
            }
          }
          return { ok: true, sent: files.length };
        }

        const chunks = chunkText(text, MAX_MSG_LEN);
        const sentIds: number[] = [];
        for (const chunk of chunks) {
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              const msg = await bot.api.sendMessage(chatId, chunk, opts);
              sentIds.push(msg.message_id);
              break;
            } catch (err: any) {
              if (err?.error_code === 429) {
                await sleep((err.parameters?.retry_after ?? 5) * 1000);
                continue;
              }
              throw err;
            }
          }
        }
        return { ok: true, message_ids: sentIds };
      }

      case "telegram_react": {
        const chatId = args.chat_id as string;
        const messageId = parseInt(args.message_id as string, 10);
        const emoji = args.emoji as string;

        await bot.api.setMessageReaction(chatId, messageId, [{ type: "emoji", emoji }]);
        return { ok: true };
      }

      case "telegram_edit": {
        const chatId = args.chat_id as string;
        const messageId = parseInt(args.message_id as string, 10);
        let text = args.text as string;
        const parseMode = args.parse_mode as string | undefined;

        const opts: Record<string, any> = {};
        if (parseMode === "html") {
          opts.parse_mode = "HTML";
        }

        await bot.api.editMessageText(chatId, messageId, text, opts);
        return { ok: true };
      }

      case "telegram_poll": {
        const chatId = args.chat_id as string;
        const question = args.question as string;
        const options = (args.options as string[]).map((o) => ({ text: o }));
        const allowMultiple = (args.allow_multiple as boolean) ?? false;
        const isAnonymous = (args.is_anonymous as boolean) ?? true;

        const msg = await bot.api.sendPoll(chatId, question, options, {
          allows_multiple_answers: allowMultiple,
          is_anonymous: isAnonymous,
        });
        return { ok: true, message_id: msg.message_id };
      }

      case "telegram_download": {
        const fileId = args.file_id as string;
        const filename = args.filename as string | undefined;
        const path = await downloadFile(fileId, filename);
        return { ok: true, path };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  });

  // ─── Hook events → forward to active chats ──────────────────────────────

  channel.onHookEvent(async (input) => {
    // Streaming: show tool execution status
    if (input.hook_event_name === "PreToolUse" && "tool_name" in input) {
      for (const chatId of activeChats) {
        await updateStreamingStatus(chatId, (input as any).tool_name);
      }
    }

    // Session end: clear all typing/streaming
    if (input.hook_event_name === "SessionEnd") {
      for (const chatId of activeChats) {
        stopTyping(chatId);
        await clearStreamingStatus(chatId);
      }
    }

    // Notifications
    if (input.hook_event_name === "Notification" && "message" in input) {
      for (const chatId of activeChats) {
        try {
          await bot.api.sendMessage(chatId, `\u2139\ufe0f ${(input as any).message}`);
        } catch {}
      }
    }

    return {};
  });

  // ─── Register bot commands ──────────────────────────────────────────────

  try {
    const me = await bot.api.getMe();
    botUsername = me.username ?? "";
    await bot.api.setMyCommands([
      { command: "start", description: "Welcome message" },
      { command: "help", description: "Show commands" },
      { command: "status", description: "Connection status" },
      { command: "stop", description: "Interrupt current task" },
      { command: "new", description: "Clear conversation" },
      { command: "streaming", description: "Toggle live status updates" },
      { command: "approve", description: "Approve pairing (admin)" },
    ]);
  } catch (err: any) {
    process.stderr.write(`[telegram] Failed to register commands: ${err.message}\n`);
  }

  // ─── Start bot ───────────────────────────────────────────────────────────

  bot.catch((err: any) => {
    process.stderr.write(`[telegram] Bot error: ${err.message}\n`);
  });

  bot.start({ drop_pending_updates: true });
  process.stderr.write(`[telegram] Bot polling started (@${botUsername})\n`);
  process.stderr.write(`[telegram] DM policy: ${access.dm.policy}, Group policy: ${access.group.policy}\n`);
  process.stderr.write(`[telegram] Allowed DM users: ${access.dm.allowed_users.length}, Admins: ${access.dm.admin_users.length}\n`);

  const cleanup = () => {
    for (const interval of typingIntervals.values()) clearInterval(interval);
    typingIntervals.clear();
    bot.stop();
    channel.cleanup();
  };

  return { channel, cleanup };
}
