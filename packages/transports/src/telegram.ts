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
import type { Transport, TransportAdapter, ConnectionHandler, MessageHandler, ProtocolMessage } from "@gettalon/protocol";
import { HubConfigService } from "@gettalon/hub-runtime";

const API = "https://api.telegram.org/bot";
const COHERE_TRANSCRIBE_URL = "https://api.cohere.com/v2/audio/transcriptions";

async function tgCall(token: string, method: string, body?: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${API}${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json() as any;
  if (!data.ok) throw new Error(`Telegram API error: ${data.description}`);
  return data.result;
}

/** Download a file from Telegram by file_id. Returns the raw file buffer. */
async function tgDownloadFile(token: string, fileId: string): Promise<Buffer> {
  const fileInfo = await tgCall(token, "getFile", { file_id: fileId });
  const filePath = fileInfo.file_path;
  const res = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`);
  if (!res.ok) throw new Error(`Failed to download Telegram file: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Transcribe audio using local MLX Whisper (primary) or Cohere API (fallback). */
async function transcribeAudio(audioBuffer: Buffer, cohereApiKey?: string): Promise<string> {
  // Try local MLX Whisper first (no API key needed, runs on Apple Silicon)
  try {
    const { writeFileSync, unlinkSync } = await import("node:fs");
    const { execSync } = await import("node:child_process");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const tmpFile = join(tmpdir(), `voice-${Date.now()}.ogg`);
    writeFileSync(tmpFile, audioBuffer);
    const outputDir = tmpdir();
    execSync(`mlx_whisper "${tmpFile}" --model mlx-community/whisper-large-v3-turbo --output-format txt --output-dir "${outputDir}" --verbose False >/dev/null 2>&1`, { encoding: "utf-8", timeout: 120000 });
    try { unlinkSync(tmpFile); } catch {}
    // mlx_whisper writes a .txt file with the transcription
    try {
      const { readFileSync } = await import("node:fs");
      const baseName = `voice-${tmpFile.match(/voice-(\d+)/)?.[1]}`;
      const txtFile = join(outputDir, baseName + ".txt");
      const text = readFileSync(txtFile, "utf-8").trim();
      try { unlinkSync(txtFile); } catch {}
      if (text) return text;
    } catch {}
  } catch {
    // MLX Whisper not available — fall through to Cohere
  }

  // Fallback: Cohere Transcribe API
  if (cohereApiKey) {
    return cohereTranscribe(audioBuffer, cohereApiKey);
  }

  throw new Error("No STT backend available (install mlx_whisper or set COHERE_API_KEY)");
}

/** Convert text to speech. Tries Edge TTS (high quality) → macOS say (fallback). */
async function textToSpeech(text: string, voice?: string): Promise<Buffer> {
  const { execSync } = await import("node:child_process");
  const { readFileSync, unlinkSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const ts = Date.now();
  const hasChinese = /[\u4e00-\u9fff]/.test(text);

  // 1. Try Edge TTS (Microsoft, high quality, free)
  try {
    const mp3File = join(tmpdir(), `tts-${ts}.mp3`);
    const oggFile = join(tmpdir(), `tts-${ts}.ogg`);
    const edgeVoice = voice ?? (hasChinese ? "zh-CN-XiaoxiaoNeural" : "en-US-AriaNeural");
    execSync(`edge-tts --voice "${edgeVoice}" --text ${JSON.stringify(text)} --write-media "${mp3File}" 2>/dev/null`, { timeout: 30000 });
    execSync(`ffmpeg -y -i "${mp3File}" -c:a libopus -b:a 48k "${oggFile}" 2>/dev/null`, { timeout: 30000 });
    const buf = readFileSync(oggFile);
    try { unlinkSync(mp3File); } catch {}
    try { unlinkSync(oggFile); } catch {}
    return buf;
  } catch {}

  // 2. Fallback: macOS say
  const aiffFile = join(tmpdir(), `tts-${ts}.aiff`);
  const oggFile = join(tmpdir(), `tts-${ts}.ogg`);
  const sayVoice = voice ?? (hasChinese ? "Flo (Chinese (Taiwan))" : "Samantha");
  execSync(`say -v "${sayVoice}" -o "${aiffFile}" ${JSON.stringify(text)}`, { timeout: 30000 });
  execSync(`ffmpeg -y -i "${aiffFile}" -c:a libopus -b:a 48k "${oggFile}" 2>/dev/null`, { timeout: 30000 });
  const buf = readFileSync(oggFile);
  try { unlinkSync(aiffFile); } catch {}
  try { unlinkSync(oggFile); } catch {}
  return buf;
}

/** Transcribe audio using the Cohere Transcribe API. Returns the transcribed text. */
async function cohereTranscribe(audioBuffer: Buffer, apiKey: string): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([audioBuffer], { type: "audio/ogg" }), "voice.ogg");

  const res = await fetch(COHERE_TRANSCRIBE_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "unknown error");
    throw new Error(`Cohere Transcribe API error (${res.status}): ${errText}`);
  }

  const data = await res.json() as any;
  return data.text ?? "";
}

class TelegramTransport implements Transport {
  readonly type = "telegram";
  private _connected = true;

  /** Cohere API key for voice transcription (STT) */
  cohereApiKey: string | undefined;

  constructor(
    private token: string,
    readonly chatId: string,
    public onMessage?: MessageHandler,
  ) {}

  get connected() { return this._connected; }

  async send(message: ProtocolMessage): Promise<void> {
    if (!this._connected) throw new Error("Not connected");
    const msg = message as any;

    // Chat/reply messages: render for Telegram
    if (msg.type === "chat" || msg.type === "reply") {
      // Voice response: if meta.voice is set and there's audio data, send as voice
      if (msg.meta?.voice === "true" && msg.meta?.audio_data) {
        const targetChat = msg.chat_id ?? this.chatId;
        await this.sendVoice(targetChat, Buffer.from(msg.meta.audio_data, "base64"));
        return;
      }

      const text = msg.content ?? msg.text ?? "";
      const from = msg.from ? `[${msg.from}] ` : "";
      const parseMode = msg.format === "html" ? "HTML" : msg.format === "markdown" ? "MarkdownV2" : undefined;
      // Use message's chat_id if provided (allows sending to any user via this bot)
      const targetChat = msg.chat_id ?? this.chatId;

      // Build reply_to parameter for threading
      const replyToId = msg.reply_to ? parseInt(String(msg.reply_to), 10) : undefined;
      const replyParams = replyToId && !isNaN(replyToId) ? { reply_parameters: { message_id: replyToId } } : {};

      // Build inline keyboard from buttons
      const replyMarkup = msg.buttons?.length ? {
        inline_keyboard: [msg.buttons.map((b: any) => b.url ? { text: b.text, url: b.url } : { text: b.text, callback_data: b.action ?? b.text })]
      } : undefined;

      // ── Special meta-driven sends ─────────────────────────────────

      // Edit existing message
      if (msg.meta?.edit_message_id) {
        const editId = parseInt(msg.meta.edit_message_id, 10);
        if (!isNaN(editId)) {
          await this.editMessage(editId, `${from}${text}`, parseMode);
          return;
        }
      }

      // Delete a message
      if (msg.meta?.delete_message_id) {
        const delId = parseInt(msg.meta.delete_message_id, 10);
        if (!isNaN(delId)) {
          await this.deleteMessage(targetChat, delId);
          return;
        }
      }

      // Answer callback query
      if (msg.meta?.callback_query_id) {
        await this.answerCallbackQuery(msg.meta.callback_query_id, text || undefined, msg.meta.show_alert === "true");
        return;
      }

      // Location
      if (msg.meta?.latitude && msg.meta?.longitude) {
        const lat = parseFloat(msg.meta.latitude);
        const lng = parseFloat(msg.meta.longitude);
        if (!isNaN(lat) && !isNaN(lng)) {
          // Venue has title + address
          if (msg.meta.venue_title && msg.meta.venue_address) {
            await this.sendVenue(targetChat, lat, lng, msg.meta.venue_title, msg.meta.venue_address, replyToId);
          } else {
            await this.sendLocation(targetChat, lat, lng, replyToId);
          }
          return;
        }
      }

      // Contact
      if (msg.meta?.phone_number && msg.meta?.contact_first_name) {
        await this.sendContact(targetChat, msg.meta.phone_number, msg.meta.contact_first_name, msg.meta.contact_last_name);
        return;
      }

      // Poll
      if (msg.meta?.poll_question && msg.meta?.poll_options) {
        try {
          const options = JSON.parse(msg.meta.poll_options) as string[];
          const isAnonymous = msg.meta.poll_anonymous !== "false";
          const allowsMultiple = msg.meta.poll_multiple === "true";
          await this.sendPoll(targetChat, msg.meta.poll_question, options, isAnonymous, allowsMultiple);
          return;
        } catch {}
      }

      // ── File sends with enhanced type routing ─────────────────────

      if (msg.files?.length) {
        // Media group: multiple photos/videos in one message
        if (msg.files.length > 1 && msg.files.every((f: any) => f.data && (f.mime?.startsWith("image/") || f.mime?.startsWith("video/")))) {
          try {
            const media = msg.files.map((f: any) => ({
              type: f.mime?.startsWith("image/") ? "photo" as const : "video" as const,
              data: Buffer.from(f.data, "base64"),
              mime: f.mime,
              caption: f === msg.files[0] ? (text || undefined) : undefined,
              name: f.name,
            }));
            await this.sendMediaGroup(targetChat, media);
            return;
          } catch {
            // Fall through to individual sends
          }
        }

        for (const file of msg.files) {
          if (file.path) {
            // Local file -> read and upload
            try {
              const { readFileSync } = await import("node:fs");
              const buf = readFileSync(file.path);
              const blob = new Blob([buf]);
              const form = new FormData();
              form.append("chat_id", targetChat);
              const method = this.pickSendMethod(file.mime, file.name);
              const fieldName = method === "sendPhoto" ? "photo" : method === "sendAudio" ? "audio" : method === "sendVideo" ? "video" : method === "sendAnimation" ? "animation" : method === "sendVideoNote" ? "video_note" : "document";
              form.append(fieldName, blob, file.name ?? "file");
              if (msg.caption || text) form.append("caption", msg.caption ?? text);
              await fetch(`${API}${this.token}/${method}`, { method: "POST", body: form }).catch(() => {});
            } catch {}
          } else if (file.data) {
            // Base64 file -> send with correct method
            const buf = Buffer.from(file.data, "base64");
            const blob = new Blob([buf]);
            const form = new FormData();
            form.append("chat_id", targetChat);
            const method = this.pickSendMethod(file.mime, file.name);
            const fieldName = method === "sendPhoto" ? "photo" : method === "sendAudio" ? "audio" : method === "sendVideo" ? "video" : method === "sendAnimation" ? "animation" : method === "sendVideoNote" ? "video_note" : method === "sendSticker" ? "sticker" : "document";
            form.append(fieldName, blob, file.name ?? "file");
            if (msg.caption || text) form.append("caption", msg.caption ?? text);
            const res = await fetch(`${API}${this.token}/${method}`, { method: "POST", body: form });
            if (!res.ok) process.stderr.write(`[telegram] File send failed: ${await res.text().catch(() => res.status)}\n`);
          } else if (file.url) {
            await this.sendText(`\u{1F4CE} ${file.name}: ${file.url}`);
          }
        }
      }

      // TTS: convert text to voice message if requested
      if (msg.meta?.tts === "true" || msg.meta?.voice === "true") {
        try {
          if (msg.meta?.audio_data) {
            // Pre-generated audio -- send directly
            await this.sendVoice(targetChat, Buffer.from(msg.meta.audio_data, "base64"));
          } else {
            // Generate TTS audio from text
            const audio = await textToSpeech(`${from}${text}`, msg.meta?.tts_voice);
            await this.sendVoice(targetChat, audio);
          }
          return;
        } catch {
          // TTS failed -- fall through to text
        }
      }

      // Send text with optional buttons and threading
      if (text || from) {
        await tgCall(this.token, "sendMessage", {
          chat_id: targetChat,
          text: `${from}${text}`,
          ...(parseMode ? { parse_mode: parseMode } : {}),
          ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
          ...replyParams,
        });
      }
      return;
    }

    // File transfer (legacy): send as document
    if (msg.type === "file_transfer" && msg.data) {
      try {
        const buf = Buffer.from(msg.data, "base64");
        const blob = new Blob([buf]);
        const form = new FormData();
        form.append("chat_id", this.chatId);
        form.append("document", blob, msg.filename ?? "file");
        await fetch(`${API}${this.token}/sendDocument`, { method: "POST", body: form });
        return;
      } catch {}
    }

    // Silent protocol messages -- don't send to Telegram chat
    const silentTypes = ["heartbeat", "heartbeat_ack", "ack", "register", "register_ack", "stream_start", "stream_chunk", "stream_end"];
    if (silentTypes.includes(msg.type)) return;

    // Other protocol messages (tool_call, tool_result, etc.): send as JSON
    await this.sendText(JSON.stringify(message));
  }

  /** Pick the correct Telegram send method based on MIME type and filename */
  private pickSendMethod(mime?: string, name?: string): string {
    if (!mime) return "sendDocument";
    if (mime === "image/gif" || mime === "video/gif") return "sendAnimation";
    if (mime === "image/webp" && name?.endsWith(".webp")) return "sendSticker";
    if (mime.startsWith("image/")) return "sendPhoto";
    if (mime.startsWith("audio/")) return "sendAudio";
    if (mime === "video/mp4" && name?.includes("video_note")) return "sendVideoNote";
    if (mime.startsWith("video/")) return "sendVideo";
    return "sendDocument";
  }

  /** Send text with chunking for Telegram's 4096 char limit */
  private async sendText(text: string): Promise<void> {
    if (text.length <= 4096) {
      await tgCall(this.token, "sendMessage", { chat_id: this.chatId, text });
    } else {
      for (let i = 0; i < text.length; i += 4000) {
        await tgCall(this.token, "sendMessage", { chat_id: this.chatId, text: text.slice(i, i + 4000) });
      }
    }
  }

  /** Send a photo by file path or URL */
  async sendPhoto(photo: string, caption?: string): Promise<void> {
    await tgCall(this.token, "sendMessage", { chat_id: this.chatId, text: caption ? `📷 ${caption}` : "📷 [photo]" });
  }

  /** Send a voice message (.ogg audio) to a chat via Telegram sendVoice API */
  async sendVoice(chatId: string, audio: Buffer, caption?: string): Promise<void> {
    const form = new FormData();
    form.append("chat_id", chatId);
    form.append("voice", new Blob([audio], { type: "audio/ogg" }), "voice.ogg");
    if (caption) form.append("caption", caption);
    await fetch(`${API}${this.token}/sendVoice`, { method: "POST", body: form });
  }

  /** React to a message with emoji */
  async react(messageId: number, emoji: string): Promise<void> {
    await tgCall(this.token, "setMessageReaction", { chat_id: this.chatId, message_id: messageId, reaction: [{ type: "emoji", emoji }] }).catch(() => {});
  }

  /** Edit a previously sent message */
  async editMessage(messageId: number, text: string, parseMode?: string): Promise<void> {
    await tgCall(this.token, "editMessageText", {
      chat_id: this.chatId,
      message_id: messageId,
      text,
      ...(parseMode ? { parse_mode: parseMode } : {}),
    });
  }

  /** Delete a message */
  async deleteMessage(chatId: string, messageId: number): Promise<void> {
    await tgCall(this.token, "deleteMessage", { chat_id: chatId, message_id: messageId });
  }

  /** Answer a callback query (button click) */
  async answerCallbackQuery(callbackQueryId: string, text?: string, showAlert?: boolean): Promise<void> {
    await tgCall(this.token, "answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      ...(text ? { text } : {}),
      ...(showAlert ? { show_alert: true } : {}),
    });
  }

  /** Send a location */
  async sendLocation(chatId: string, latitude: number, longitude: number, replyTo?: number): Promise<void> {
    await tgCall(this.token, "sendLocation", {
      chat_id: chatId,
      latitude,
      longitude,
      ...(replyTo ? { reply_parameters: { message_id: replyTo } } : {}),
    });
  }

  /** Send a venue */
  async sendVenue(chatId: string, latitude: number, longitude: number, title: string, address: string, replyTo?: number): Promise<void> {
    await tgCall(this.token, "sendVenue", {
      chat_id: chatId,
      latitude,
      longitude,
      title,
      address,
      ...(replyTo ? { reply_parameters: { message_id: replyTo } } : {}),
    });
  }

  /** Send a contact */
  async sendContact(chatId: string, phoneNumber: string, firstName: string, lastName?: string): Promise<void> {
    await tgCall(this.token, "sendContact", {
      chat_id: chatId,
      phone_number: phoneNumber,
      first_name: firstName,
      ...(lastName ? { last_name: lastName } : {}),
    });
  }

  /** Send a poll */
  async sendPoll(chatId: string, question: string, options: string[], isAnonymous = true, allowsMultiple = false): Promise<void> {
    await tgCall(this.token, "sendPoll", {
      chat_id: chatId,
      question,
      options,
      is_anonymous: isAnonymous,
      allows_multiple_answers: allowsMultiple,
    });
  }

  /** Send an animation (GIF) */
  async sendAnimation(chatId: string, animation: Buffer, caption?: string, fileName?: string): Promise<void> {
    const form = new FormData();
    form.append("chat_id", chatId);
    form.append("animation", new Blob([animation], { type: "video/mp4" }), fileName ?? "animation.gif");
    if (caption) form.append("caption", caption);
    await fetch(`${API}${this.token}/sendAnimation`, { method: "POST", body: form });
  }

  /** Send a video note (round video) */
  async sendVideoNote(chatId: string, videoNote: Buffer): Promise<void> {
    const form = new FormData();
    form.append("chat_id", chatId);
    form.append("video_note", new Blob([videoNote], { type: "video/mp4" }), "video_note.mp4");
    await fetch(`${API}${this.token}/sendVideoNote`, { method: "POST", body: form });
  }

  /** Send a sticker by file_id or buffer */
  async sendSticker(chatId: string, sticker: string | Buffer): Promise<void> {
    if (typeof sticker === "string") {
      // file_id or URL
      await tgCall(this.token, "sendSticker", { chat_id: chatId, sticker });
    } else {
      const form = new FormData();
      form.append("chat_id", chatId);
      form.append("sticker", new Blob([sticker], { type: "image/webp" }), "sticker.webp");
      await fetch(`${API}${this.token}/sendSticker`, { method: "POST", body: form });
    }
  }

  /** Send a media group (multiple photos/videos in one message) */
  async sendMediaGroup(chatId: string, media: Array<{ type: "photo" | "video"; data: Buffer; mime?: string; caption?: string; name?: string }>): Promise<void> {
    const form = new FormData();
    form.append("chat_id", chatId);
    const mediaArr: any[] = [];
    for (let i = 0; i < media.length; i++) {
      const m = media[i];
      const attachName = `file${i}`;
      form.append(attachName, new Blob([m.data], { type: m.mime ?? (m.type === "photo" ? "image/jpeg" : "video/mp4") }), m.name ?? `${attachName}.${m.type === "photo" ? "jpg" : "mp4"}`);
      mediaArr.push({
        type: m.type,
        media: `attach://${attachName}`,
        ...(m.caption && i === 0 ? { caption: m.caption } : {}),
      });
    }
    form.append("media", JSON.stringify(mediaArr));
    await fetch(`${API}${this.token}/sendMediaGroup`, { method: "POST", body: form });
  }

  async close(): Promise<void> {
    this._connected = false;
  }

  /** Feed an incoming Telegram message into the transport */
  handleIncoming(text: string, meta?: {
    message_id?: number;
    from?: { id: number; username?: string; first_name?: string };
    voice?: boolean;
    duration?: number;
    file_id?: string;
    reply_to_message?: { message_id?: number; from?: { username?: string; first_name?: string }; text?: string };
    forward_from?: { username?: string; first_name?: string };
    edited?: boolean;
  }): void {
    // Acknowledge receipt with emoji reaction (skip for edits)
    if (meta?.message_id && !meta?.edited) {
      tgCall(this.token, "setMessageReaction", {
        chat_id: this.chatId,
        message_id: meta.message_id,
        reaction: [{ type: "emoji", emoji: "👍" }],
      }).catch(() => {}); // Silently fail if reactions not supported
    }

    // Try JSON protocol message first
    try {
      const msg = JSON.parse(text) as ProtocolMessage;
      this.onMessage?.(msg);
      return;
    } catch {}

    // Human text -> wrap as chat message
    // Use this.chatId (the Telegram chat.id) -- for groups this is the group ID, for DMs the user ID
    const fromName = meta?.from?.username ?? meta?.from?.first_name ?? String(meta?.from?.id ?? "unknown");
    const chatMsg: any = { type: "chat", chat_id: this.chatId, content: text, from: fromName };
    const msgMeta: Record<string, string> = {};
    let hasMeta = false;

    if (meta?.voice) {
      msgMeta.voice = "true";
      if (meta.duration != null) msgMeta.duration = String(meta.duration);
      if (meta.file_id) msgMeta.file_id = meta.file_id;
      hasMeta = true;
    }

    if (meta?.reply_to_message) {
      const reply = meta.reply_to_message;
      if (reply.message_id != null) { msgMeta.reply_to_id = String(reply.message_id); hasMeta = true; }
      const replyFrom = reply.from?.username ?? reply.from?.first_name;
      if (replyFrom) { msgMeta.reply_to_user = replyFrom; hasMeta = true; }
      if (reply.text) { msgMeta.reply_to_text = reply.text.slice(0, 200); hasMeta = true; }
      // Prepend reply context to content
      const replyPreview = reply.text ? reply.text.slice(0, 80) : "";
      chatMsg.content = `[↩ ${replyFrom ?? ""}${replyPreview ? ": " + replyPreview : ""}]\n${text}`;
    }

    if (meta?.forward_from) {
      const fwd = meta.forward_from;
      const fwdName = fwd.username ?? fwd.first_name ?? "unknown";
      msgMeta.forwarded_from = fwdName;
      hasMeta = true;
      // Prepend forward info to content
      chatMsg.content = `[⤳ Forwarded from ${fwdName}]\n${text}`;
    }

    if (meta?.edited) {
      msgMeta.edited = "true";
      hasMeta = true;
    }

    if (hasMeta) chatMsg.meta = msgMeta;
    this.onMessage?.(chatMsg);
  }
}

export class TelegramAdapter implements TransportAdapter {
  readonly type = "telegram";
  private token: string;
  private polling = false;
  private pollGeneration = 0; // incremented on each startPolling to invalidate old loops
  private transports = new Map<string, TelegramTransport>(); // chatId → transport
  private connectionHandler: ConnectionHandler | null = null;
  private lastUpdateId = 0;

  private sendOnly: boolean;
  private fallbackHandler: MessageHandler | null = null; // handler from connect() for new chatIds

  /** Cohere API key for voice transcription (STT) */
  private cohereApiKey: string | undefined;

  // Webhook configuration
  private webhookUrl: string | undefined;
  private webhookPort: number;
  private webhookPath: string;
  private webhookServer: import("node:http").Server | null = null;
  private webhookRegistered = false;

  constructor(config: Record<string, unknown> = {}) {
    const _cfg = HubConfigService.fromEnv();
    this.token = (config.botToken as string) ?? _cfg.telegramBotToken() ?? "";
    this.sendOnly = (config.sendOnly as boolean) ?? false;
    this.cohereApiKey = (config.cohereApiKey as string) ?? _cfg.cohereApiKey();
    this.webhookUrl = (config.webhookUrl as string) ?? _cfg.telegramWebhookUrl();
    this.webhookPort = (config.webhookPort as number) ?? _cfg.telegramTransportWebhookPort();
    this.webhookPath = (config.webhookPath as string) ?? _cfg.telegramWebhookPath();
    if (!this.token) throw new Error("Telegram transport requires botToken or TELEGRAM_BOT_TOKEN env var");
  }

  /** Whether webhook mode is enabled */
  private get useWebhook(): boolean {
    return !!this.webhookUrl;
  }

  // ── Update dispatching (shared by polling and webhook) ─────────────────

  /** Route a raw Telegram update to the appropriate transport */
  private dispatchUpdate(update: any): void {
    // ── Callback query (button clicks) ─────────────────────────────
    if (update.callback_query) {
      const cb = update.callback_query;
      const chatId = cb.message?.chat?.id ? String(cb.message.chat.id) : null;
      if (!chatId) return;

      const target = this.getOrCreateTransport(chatId);
      const fromName = cb.from?.username ?? cb.from?.first_name ?? String(cb.from?.id ?? "unknown");

      target.onMessage?.({
        type: "chat",
        chat_id: chatId,
        content: cb.data ?? "",
        from: fromName,
        meta: {
          callback_query_id: cb.id ?? "",
          callback_data: cb.data ?? "",
          ...(cb.message?.message_id != null ? { original_message_id: String(cb.message.message_id) } : {}),
          ...(cb.message?.text ? { original_message_text: cb.message.text.slice(0, 200) } : {}),
        },
      } as any);

      // Auto-answer callback query to dismiss the loading indicator
      if (cb.id) {
        tgCall(this.token, "answerCallbackQuery", { callback_query_id: cb.id }).catch(() => {});
      }
      return;
    }

    // ── Edited message ─────────────────────────────────────────────
    const msg = update.edited_message ?? update.message;
    const isEdited = !!update.edited_message;
    if (!msg) return;

    // Handle any content type
    const hasVoice = !!(msg.voice || msg.audio);
    const hasPhoto = !!(msg.photo?.length);
    const hasDocument = !!msg.document;
    const hasVideo = !!msg.video;
    const hasSticker = !!msg.sticker;
    const hasVideoNote = !!msg.video_note;
    const hasAnimation = !!msg.animation;
    const hasLocation = !!msg.location;
    const hasVenue = !!msg.venue;
    const hasContact = !!msg.contact;
    const hasPoll = !!msg.poll;
    const hasDice = !!msg.dice;

    const hasContent = msg.text || hasVoice || hasPhoto || hasDocument || hasVideo
      || hasSticker || hasVideoNote || hasAnimation || hasLocation || hasVenue
      || hasContact || hasPoll || hasDice;
    if (!hasContent) return;

    const chatId = String(msg.chat.id);
    const target = this.getOrCreateTransport(chatId);

    // Build common meta for handleIncoming
    const baseMeta: any = {
      message_id: msg.message_id,
      from: msg.from,
      ...(isEdited ? { edited: true } : {}),
      ...(msg.reply_to_message ? { reply_to_message: msg.reply_to_message } : {}),
      ...(msg.forward_from ? { forward_from: msg.forward_from } : {}),
    };

    // ── File-like messages (download + forward) ─────────────────────
    if (hasPhoto || hasDocument || hasVideo || hasSticker || hasVideoNote || hasAnimation) {
      this.handleFileMessage(target, msg, { hasPhoto, hasDocument, hasVideo, hasSticker, hasVideoNote, hasAnimation });
      return;
    }

    // ── Voice/audio ─────────────────────────────────────────────────
    if (hasVoice) {
      const voiceObj = msg.voice ?? msg.audio;
      const fileId = voiceObj.file_id as string;
      const duration = voiceObj.duration as number | undefined;
      this.handleVoiceMessage(target, msg, fileId, duration);
      return;
    }

    // ── Location ────────────────────────────────────────────────────
    if (hasLocation && !hasVenue) {
      const loc = msg.location;
      const fromName = msg.from?.username ?? msg.from?.first_name ?? String(msg.from?.id ?? "unknown");
      target.onMessage?.({
        type: "chat",
        chat_id: chatId,
        content: `[Location: ${loc.latitude}, ${loc.longitude}]`,
        from: fromName,
        meta: {
          latitude: String(loc.latitude),
          longitude: String(loc.longitude),
          ...(msg.message_id != null ? { message_id: String(msg.message_id) } : {}),
          ...(isEdited ? { edited: "true" } : {}),
        },
      } as any);
      return;
    }

    // ── Venue ───────────────────────────────────────────────────────
    if (hasVenue) {
      const venue = msg.venue;
      const fromName = msg.from?.username ?? msg.from?.first_name ?? String(msg.from?.id ?? "unknown");
      target.onMessage?.({
        type: "chat",
        chat_id: chatId,
        content: `[Venue: ${venue.title} - ${venue.address} (${venue.location?.latitude}, ${venue.location?.longitude})]`,
        from: fromName,
        meta: {
          latitude: String(venue.location?.latitude ?? 0),
          longitude: String(venue.location?.longitude ?? 0),
          venue_title: venue.title ?? "",
          venue_address: venue.address ?? "",
          ...(msg.message_id != null ? { message_id: String(msg.message_id) } : {}),
        },
      } as any);
      return;
    }

    // ── Contact ─────────────────────────────────────────────────────
    if (hasContact) {
      const contact = msg.contact;
      const name = [contact.first_name, contact.last_name].filter(Boolean).join(" ");
      const fromName = msg.from?.username ?? msg.from?.first_name ?? String(msg.from?.id ?? "unknown");
      target.onMessage?.({
        type: "chat",
        chat_id: chatId,
        content: `[Contact: ${name}, ${contact.phone_number ?? ""}]`,
        from: fromName,
        meta: {
          phone_number: contact.phone_number ?? "",
          contact_first_name: contact.first_name ?? "",
          ...(contact.last_name ? { contact_last_name: contact.last_name } : {}),
          ...(msg.message_id != null ? { message_id: String(msg.message_id) } : {}),
        },
      } as any);
      return;
    }

    // ── Poll ────────────────────────────────────────────────────────
    if (hasPoll) {
      const poll = msg.poll;
      const options = (poll.options ?? []).map((o: any) => o.text).join(", ");
      const fromName = msg.from?.username ?? msg.from?.first_name ?? String(msg.from?.id ?? "unknown");
      target.onMessage?.({
        type: "chat",
        chat_id: chatId,
        content: `[Poll: ${poll.question}] Options: ${options}`,
        from: fromName,
        meta: {
          poll_question: poll.question ?? "",
          poll_options: JSON.stringify((poll.options ?? []).map((o: any) => o.text)),
          ...(msg.message_id != null ? { message_id: String(msg.message_id) } : {}),
        },
      } as any);
      return;
    }

    // ── Dice ────────────────────────────────────────────────────────
    if (hasDice) {
      const dice = msg.dice;
      const fromName = msg.from?.username ?? msg.from?.first_name ?? String(msg.from?.id ?? "unknown");
      target.onMessage?.({
        type: "chat",
        chat_id: chatId,
        content: `[Dice: ${dice.emoji ?? "\u{1F3B2}"} = ${dice.value}]`,
        from: fromName,
        meta: {
          dice_emoji: dice.emoji ?? "",
          dice_value: String(dice.value ?? 0),
          ...(msg.message_id != null ? { message_id: String(msg.message_id) } : {}),
        },
      } as any);
      return;
    }

    // ── Text message ────────────────────────────────────────────────
    target.handleIncoming(msg.text, baseMeta);
  }

  /** Get or create a transport for a chatId */
  private getOrCreateTransport(chatId: string): TelegramTransport {
    let target = this.transports.get(chatId);
    if (!target) {
      target = new TelegramTransport(this.token, chatId, this.fallbackHandler ?? undefined);
      target.cohereApiKey = this.cohereApiKey;
      this.transports.set(chatId, target);
      if (this.connectionHandler) this.connectionHandler(target);
    }
    return target;
  }

  /** Handle voice/audio messages: download from Telegram, transcribe via Cohere, dispatch as text */
  private async handleVoiceMessage(
    target: TelegramTransport,
    msg: any,
    fileId: string,
    duration?: number,
  ): Promise<void> {
    try {
      const audioBuffer = await tgDownloadFile(this.token, fileId);
      const transcribedText = await transcribeAudio(audioBuffer, this.cohereApiKey);
      target.handleIncoming(transcribedText || "[Voice message - empty transcription]", {
        message_id: msg.message_id,
        from: msg.from,
        voice: true,
        duration,
        file_id: fileId,
      });
    } catch (err: any) {
      process.stderr.write(`[telegram-transport] Voice transcription failed: ${err.message}\n`);
      target.handleIncoming("[Voice message - transcription failed]", {
        message_id: msg.message_id,
        from: msg.from,
        voice: true,
        duration,
        file_id: fileId,
      });
    }
  }

  /** Handle photo/document/video/sticker/video_note/animation messages: download file, forward as chat with attachment. */
  private async handleFileMessage(
    target: TelegramTransport,
    msg: any,
    types: { hasPhoto?: boolean; hasDocument?: boolean; hasVideo?: boolean; hasSticker?: boolean; hasVideoNote?: boolean; hasAnimation?: boolean },
  ): Promise<void> {
    try {
      let fileId: string;
      let fileName: string;
      let mime: string;

      if (types.hasPhoto) {
        // Telegram sends multiple sizes -- take the largest
        const photo = msg.photo[msg.photo.length - 1];
        fileId = photo.file_id;
        fileName = "photo.jpg";
        mime = "image/jpeg";
      } else if (types.hasAnimation) {
        // Animation (GIF) -- must check before document since GIFs also have document
        fileId = msg.animation.file_id;
        fileName = msg.animation.file_name ?? "animation.gif";
        mime = msg.animation.mime_type ?? "video/mp4";
      } else if (types.hasDocument) {
        fileId = msg.document.file_id;
        fileName = msg.document.file_name ?? "document";
        mime = msg.document.mime_type ?? "application/octet-stream";
      } else if (types.hasVideo) {
        fileId = msg.video.file_id;
        fileName = msg.video.file_name ?? "video.mp4";
        mime = msg.video.mime_type ?? "video/mp4";
      } else if (types.hasVideoNote) {
        // Round video message
        fileId = msg.video_note.file_id;
        fileName = "video_note.mp4";
        mime = "video/mp4";
      } else if (types.hasSticker) {
        fileId = msg.sticker.file_id;
        fileName = "sticker.webp";
        mime = msg.sticker.is_animated ? "application/tgs" : "image/webp";
      } else {
        return;
      }

      const fileBuffer = await tgDownloadFile(this.token, fileId);
      const base64 = fileBuffer.toString("base64");
      const caption = msg.caption ?? "";
      const fromName = msg.from?.username ?? msg.from?.first_name ?? String(msg.from?.id ?? "unknown");

      // Build meta with file_id and type hint
      const meta: Record<string, string> = { file_id: fileId };
      if (types.hasVideoNote) meta.file_type = "video_note";
      if (types.hasAnimation) meta.file_type = "animation";
      if (types.hasSticker) meta.file_type = "sticker";

      // Include reply_to and forward metadata
      if (msg.reply_to_message?.message_id != null) {
        meta.reply_to_id = String(msg.reply_to_message.message_id);
        const replyFrom = msg.reply_to_message.from?.username ?? msg.reply_to_message.from?.first_name;
        if (replyFrom) meta.reply_to_user = replyFrom;
      }
      if (msg.forward_from) {
        meta.forwarded_from = msg.forward_from.username ?? msg.forward_from.first_name ?? "unknown";
      }

      // Send as chat message with file attachment
      target.onMessage?.({
        type: "chat",
        chat_id: target.chatId,
        content: caption || `[${fileName}]`,
        from: fromName,
        files: [{ name: fileName, mime, data: base64 }],
        meta,
      } as any);
    } catch (err: any) {
      process.stderr.write(`[telegram-transport] File download failed: ${err.message}\n`);
      target.handleIncoming("[File message - download failed]", { message_id: msg.message_id, from: msg.from });
    }
  }

  // ── Polling mode ──────────────────────────────────────────────────────

  /** Single poll iteration */
  private async poll(): Promise<void> {
    try {
      const updates = await tgCall(this.token, "getUpdates", {
        offset: this.lastUpdateId + 1,
        timeout: 30,
        allowed_updates: ["message", "edited_message", "callback_query"],
      }) as any[];

      for (const update of updates) {
        this.lastUpdateId = update.update_id;
        this.dispatchUpdate(update);
      }
    } catch {}
  }

  /** Start the shared poller (idempotent). Uses generation counter to invalidate old loops on reconnect. */
  private startPolling(): void {
    if (this.sendOnly) return;
    this.polling = true;
    const gen = ++this.pollGeneration;
    (async () => { while (this.polling && gen === this.pollGeneration) await this.poll(); })();
  }

  // ── Webhook mode ──────────────────────────────────────────────────────

  /** Start the webhook HTTP server and register the URL with Telegram (idempotent). */
  private async startWebhook(): Promise<void> {
    if (this.webhookServer || this.sendOnly) return;

    const http = await import("node:http");
    const webhookPath = this.webhookPath;

    this.webhookServer = http.createServer((req, res) => {
      if (req.method !== "POST" || req.url !== webhookPath) {
        res.writeHead(404);
        res.end();
        return;
      }

      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        let update: any;
        try {
          update = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
        } catch {
          res.writeHead(400);
          res.end("Bad request");
          return;
        }

        // Respond 200 immediately so Telegram does not retry
        res.writeHead(200);
        res.end("OK");

        try {
          this.dispatchUpdate(update);
        } catch (err: any) {
          process.stderr.write(`[telegram-transport] Webhook handler error: ${err.message}\n`);
        }
      });
    });

    await new Promise<void>((resolve) => {
      this.webhookServer!.listen(this.webhookPort, () => {
        process.stderr.write(
          `[telegram-transport] Webhook server listening on port ${this.webhookPort}${webhookPath}\n`,
        );
        resolve();
      });
    });

    // Register webhook URL with Telegram Bot API
    try {
      const fullUrl = this.webhookUrl!.endsWith("/")
        ? `${this.webhookUrl!.slice(0, -1)}${this.webhookPath}`
        : `${this.webhookUrl}${this.webhookPath}`;
      await tgCall(this.token, "setWebhook", {
        url: fullUrl,
        allowed_updates: ["message", "edited_message", "callback_query"],
      });
      this.webhookRegistered = true;
      process.stderr.write(`[telegram-transport] Webhook registered: ${fullUrl}\n`);
    } catch (err: any) {
      process.stderr.write(`[telegram-transport] Failed to register webhook: ${err.message}\n`);
    }
  }

  // ── Start receiving (selects webhook or polling) ───────────────────────

  /** Start receiving updates via the configured mode (idempotent). */
  private async startReceiving(): Promise<void> {
    if (this.useWebhook) {
      await this.startWebhook();
    } else {
      this.startPolling();
    }
  }

  // ── TransportAdapter interface ─────────────────────────────────────────

  /** Server mode: receive messages from agents via webhook or polling */
  async listen(_port: number, handler: ConnectionHandler): Promise<void> {
    this.connectionHandler = handler;
    await this.startReceiving();
  }

  /** Client mode: connect to a specific chat */
  /** Bot username fetched via getMe on first connect */
  botUsername: string | undefined;

  async connect(url: string, handler: MessageHandler): Promise<Transport> {
    const chatId = url.startsWith("telegram://") ? url.slice(11) : url;
    const transport = new TelegramTransport(this.token, chatId, handler);
    transport.cohereApiKey = this.cohereApiKey;
    this.transports.set(chatId, transport);
    // Store handler as fallback so messages from unknown chatIds (new users,
    // groups) still reach the hub — not just the originally connected chatId
    if (!this.fallbackHandler) this.fallbackHandler = handler;
    // Fetch bot identity on first connect
    if (!this.botUsername && this.token) {
      try {
        const me = await tgCall(this.token, "getMe", {}) as any;
        this.botUsername = me.username ?? me.first_name;
      } catch {}
    }
    await this.startReceiving();
    return transport;
  }

  /** Get the display name for this adapter (bot username or "telegram") */
  get displayName(): string {
    return this.botUsername ? `@${this.botUsername}` : "telegram";
  }

  async close(): Promise<void> {
    // Stop polling
    this.polling = false;

    // Shut down webhook server and deregister from Telegram
    if (this.webhookServer) {
      if (this.webhookRegistered) {
        try {
          await tgCall(this.token, "deleteWebhook", {});
          process.stderr.write("[telegram-transport] Webhook deleted\n");
        } catch (err: any) {
          process.stderr.write(`[telegram-transport] Failed to delete webhook: ${err.message}\n`);
        }
        this.webhookRegistered = false;
      }
      await new Promise<void>((resolve) => this.webhookServer!.close(() => resolve()));
      this.webhookServer = null;
    }

    for (const t of this.transports.values()) await t.close().catch(() => {});
    this.transports.clear();
  }
}

/** Create a Telegram transport adapter */
export function createTelegramTransport(config: Record<string, unknown> = {}): TransportAdapter {
  return new TelegramAdapter(config);
}
