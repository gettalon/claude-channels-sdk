/**
 * Telegram Channel Adapter
 *
 * Uses grammy for bot polling. Supports markdown->HTML conversion,
 * message chunking (4096 limit), inline keyboard permission prompts,
 * and extra tools: telegram_send, telegram_react, telegram_edit, telegram_poll.
 */

import { ChannelServer } from "../channel-server.js";
import type { ChannelServerOptions, ChannelPermissionRequest } from "../types.js";

// ─── Config ──────────────────────────────────────────────────────────────────

export interface TelegramConfig {
  botToken: string;
  allowedChats?: string[];
}

export function parseConfig(): TelegramConfig {
  const botToken = process.env.TELEGRAM_BOT_TOKEN ?? "";
  if (!botToken) throw new Error("TELEGRAM_BOT_TOKEN is required");

  const allowedChats = process.env.TELEGRAM_ALLOWED_CHATS
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  return { botToken, allowedChats };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const MAX_MSG_LEN = 4096;

function chunkText(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf("\n", limit);
    if (splitAt <= 0) splitAt = remaining.lastIndexOf(" ", limit);
    if (splitAt <= 0) splitAt = limit;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n/, "");
  }
  return chunks;
}

/**
 * Minimal Markdown to Telegram HTML conversion.
 * Handles bold, italic, code, pre blocks, links.
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
  // Italic *text* or _text_
  html = html.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "<i>$1</i>");
  html = html.replace(/(?<!_)_(?!_)(.+?)(?<!_)_(?!_)/g, "<i>$1</i>");
  // Links [text](url)
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
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
];

// ─── Channel Factory ─────────────────────────────────────────────────────────

export async function createTelegramChannel(
  config?: Partial<TelegramConfig>,
): Promise<{ channel: ChannelServer; cleanup: () => void }> {
  // @ts-ignore - grammy is an optional peer dependency
  const { Bot, InlineKeyboard, InputFile } = await import("grammy") as any;

  const cfg = { ...parseConfig(), ...config };
  if (!cfg.botToken) throw new Error("TELEGRAM_BOT_TOKEN is required");

  const bot = new Bot(cfg.botToken);
  const allowedSet = cfg.allowedChats ? new Set(cfg.allowedChats) : null;

  // Pending permission prompts: request_id -> { chatId, messageId }
  const pendingPermissions = new Map<string, { chatId: string; resolve?: (v: "allow" | "deny") => void }>();

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

  // ─── Inbound: Bot messages → channel.pushMessage() ───────────────────────

  bot.on("message:text", async (ctx: any) => {
    const chatId = String(ctx.chat.id);
    if (allowedSet && !allowedSet.has(chatId)) return;

    const user = ctx.from?.username ?? ctx.from?.first_name ?? "unknown";
    const messageId = String(ctx.message.message_id);

    await channel.pushMessage(ctx.message.text, {
      chat_id: chatId,
      message_id: messageId,
      user,
      ts: String(ctx.message.date),
    });
  });

  bot.on("message:photo", async (ctx: any) => {
    const chatId = String(ctx.chat.id);
    if (allowedSet && !allowedSet.has(chatId)) return;

    const user = ctx.from?.username ?? ctx.from?.first_name ?? "unknown";
    const caption = ctx.message.caption ?? "[Photo received]";
    const photos = ctx.message.photo;
    const largest = photos[photos.length - 1];

    await channel.pushMessage(caption, {
      chat_id: chatId,
      message_id: String(ctx.message.message_id),
      user,
      image_file_id: largest.file_id,
      ts: String(ctx.message.date),
    });
  });

  // ─── Callback queries (permission buttons) ──────────────────────────────

  bot.on("callback_query:data", async (ctx: any) => {
    const data = ctx.callbackQuery.data;
    if (!data.startsWith("perm:")) {
      await ctx.answerCallbackQuery();
      return;
    }

    const [, requestId, decision] = data.split(":");
    if (requestId && (decision === "allow" || decision === "deny")) {
      await channel.sendPermissionVerdict({ request_id: requestId, behavior: decision });
      pendingPermissions.delete(requestId);

      try {
        await ctx.editMessageReplyMarkup({ reply_markup: undefined });
        await ctx.editMessageText(
          `${ctx.callbackQuery.message && "text" in ctx.callbackQuery.message ? ctx.callbackQuery.message.text : "Permission request"}\n\n${decision === "allow" ? "Allowed" : "Denied"} by ${ctx.from?.username ?? ctx.from?.first_name ?? "user"}`,
        );
      } catch {
        // Message may already be edited
      }
    }
    await ctx.answerCallbackQuery({ text: `Permission ${decision}` });
  });

  // ─── Outbound: channel.onReply() → Telegram send ────────────────────────

  channel.onReply(async (chatId: string, text: string) => {
    const html = mdToHtml(text);
    const chunks = chunkText(html, MAX_MSG_LEN);
    for (let i = 0; i < chunks.length; i++) {
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
    // Send to all allowed chats, or the first chat that messaged us
    const targetChats = allowedSet ? [...allowedSet] : [];
    if (targetChats.length === 0) {
      process.stderr.write("[telegram] No target chats for permission prompt\n");
      return;
    }

    const keyboard = new InlineKeyboard()
      .text("Allow", `perm:${req.request_id}:allow`)
      .text("Deny", `perm:${req.request_id}:deny`);

    const message = [
      "<b>Permission Request</b>",
      "",
      `<b>Tool:</b> <code>${escapeHtml(req.tool_name)}</code>`,
      `<b>Description:</b> ${escapeHtml(req.description)}`,
      "",
      `<pre>${escapeHtml(req.input_preview.slice(0, 2000))}</pre>`,
    ].join("\n");

    for (const chatId of targetChats) {
      try {
        const sent = await bot.api.sendMessage(chatId, message, {
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

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  });

  // ─── Hook events → forward to active chats ──────────────────────────────

  channel.onHookEvent(async (input) => {
    // Notify allowed chats about session events
    if (input.hook_event_name === "Notification" && "message" in input) {
      const targets = allowedSet ? [...allowedSet] : [];
      for (const chatId of targets) {
        try {
          await bot.api.sendMessage(chatId, `[Notification] ${input.message}`);
        } catch {
          // Best effort
        }
      }
    }
    return {};
  });

  // ─── Start bot ───────────────────────────────────────────────────────────

  bot.catch((err: any) => {
    process.stderr.write(`[telegram] Bot error: ${err.message}\n`);
  });

  bot.start({ drop_pending_updates: true });
  process.stderr.write("[telegram] Bot polling started\n");

  const cleanup = () => {
    bot.stop();
    channel.cleanup();
  };

  return { channel, cleanup };
}
