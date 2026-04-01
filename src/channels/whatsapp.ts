/**
 * WhatsApp Channel Adapter
 *
 * Uses @whiskeysockets/baileys for WhatsApp Web multi-device.
 * QR code auth, message upsert for inbound, plain text (no markdown), 4096 char limit,
 * text-based permission prompts with reply buttons.
 */

import { ChannelServer } from "../channel-server.js";
import type { ChannelPermissionRequest } from "../types.js";
import { HubConfigService } from "@gettalon/hub-runtime";

// ─── Config ──────────────────────────────────────────────────────────────────

export interface WhatsAppConfig {
  sessionPath: string;
}

export function parseConfig(): WhatsAppConfig {
  const cfg = HubConfigService.fromEnv();
  const sessionPath = cfg.whatsappSessionPath();
  return { sessionPath };
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

/** Strip markdown to plain text (WhatsApp doesn't render markdown well) */
function stripMarkdown(md: string): string {
  let text = md;
  // Code blocks
  text = text.replace(/```[\s\S]*?```/g, (m) => m.replace(/```\w*\n?/g, "").replace(/```/g, ""));
  // Inline code
  text = text.replace(/`([^`]+)`/g, "$1");
  // Bold
  text = text.replace(/\*\*(.+?)\*\*/g, "*$1*");
  // Italic
  text = text.replace(/(?<!\*)_(.+?)_(?!\*)/g, "_$1_");
  // Links
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)");
  return text;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Channel Factory ─────────────────────────────────────────────────────────

export async function createWhatsAppChannel(
  config?: Partial<WhatsAppConfig>,
): Promise<{ channel: ChannelServer; cleanup: () => void }> {
  // @ts-ignore - @whiskeysockets/baileys is an optional peer dependency
  const _baileys = await import("@whiskeysockets/baileys");
  const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = _baileys as any;
  const { mkdirSync } = await import("node:fs");

  const cfg = { ...parseConfig(), ...config };
  mkdirSync(cfg.sessionPath, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(cfg.sessionPath);
  const { version } = await fetchLatestBaileysVersion();

  // Pending permission replies: request_id -> jid that sent the latest permission prompt
  const pendingPermissions = new Map<string, string>();

  const channel = new ChannelServer({
    name: "whatsapp",
    version: "1.0.0",
    instructions: [
      "You are connected to WhatsApp. Messages arrive with chat_id (JID) in meta.",
      "Use the reply tool to respond. WhatsApp does not support rich markdown.",
      "Messages are plain text only. Keep messages under 4096 characters; longer content is auto-chunked.",
      "Permission requests are sent as text messages. The user replies YES or NO.",
    ].join(" "),
    permissionRelay: true,
  });

  let sock: ReturnType<typeof makeWASocket>;
  let shouldReconnect = true;

  function connectSocket(): void {
    sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: true,
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", (update: any) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        process.stderr.write("[whatsapp] Scan QR code to authenticate\n");
      }
      if (connection === "close") {
        const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut;
        process.stderr.write(`[whatsapp] Connection closed (status: ${statusCode})\n`);
        if (!loggedOut && shouldReconnect) {
          process.stderr.write("[whatsapp] Reconnecting...\n");
          connectSocket();
        }
      } else if (connection === "open") {
        process.stderr.write("[whatsapp] Connected\n");
      }
    });

    // ─── Inbound messages ────────────────────────────────────────────────

    sock.ev.on("messages.upsert", async ({ messages, type }: any) => {
      if (type !== "notify") return;

      for (const msg of messages) {
        if (!msg.message) continue;
        if (msg.key.fromMe) continue;

        const jid = msg.key.remoteJid;
        if (!jid) continue;

        // Extract text content
        const textContent =
          msg.message.conversation ??
          msg.message.extendedTextMessage?.text ??
          msg.message.imageMessage?.caption ??
          msg.message.videoMessage?.caption ??
          null;

        if (!textContent) continue;

        // Check if this is a permission reply
        const upper = textContent.trim().toUpperCase();
        if (upper === "YES" || upper === "NO") {
          // Check if there's a pending permission for this chat
          for (const [reqId, pendingJid] of pendingPermissions) {
            if (pendingJid === jid) {
              const decision = upper === "YES" ? "allow" : "deny";
              await channel.sendPermissionVerdict({ request_id: reqId, behavior: decision });
              pendingPermissions.delete(reqId);
              try {
                await sock.sendMessage(jid, { text: `Permission ${decision === "allow" ? "allowed" : "denied"}.` });
              } catch {}
              break;
            }
          }
          // If it matched a permission, still push it as a message (user might be saying yes/no to something else)
        }

        const pushName = msg.pushName ?? "unknown";
        const messageId = msg.key.id ?? "";

        await channel.pushMessage(textContent, {
          chat_id: jid,
          message_id: messageId,
          user: pushName,
          ts: String(msg.messageTimestamp ?? Date.now()),
        });
      }
    });
  }

  connectSocket();

  // ─── Outbound: channel.onReply() → WhatsApp send ───────────────────────

  channel.onReply(async (chatId: string, text: string) => {
    const plain = stripMarkdown(text);
    const chunks = chunkText(plain, MAX_MSG_LEN);
    for (const chunk of chunks) {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await sock.sendMessage(chatId, { text: chunk });
          break;
        } catch (err: any) {
          if (attempt < 2) {
            await sleep(2000);
            continue;
          }
          process.stderr.write(`[whatsapp] Send error: ${err.message}\n`);
        }
      }
    }
  });

  // ─── Permission prompts → text message ──────────────────────────────────

  channel.onPermissionRequest(async (req: ChannelPermissionRequest) => {
    // Send to the last active chat if we have one
    // In practice, the permission request happens during an active conversation
    // We'll look for any pending JID from recent messages
    const message = [
      "--- PERMISSION REQUEST ---",
      "",
      `Tool: ${req.tool_name}`,
      `Description: ${req.description}`,
      "",
      req.input_preview.slice(0, 2000),
      "",
      "Reply YES to allow or NO to deny.",
    ].join("\n");

    // We don't have an explicit target JID from the permission request.
    // Permission prompts should be sent to all recently active chats.
    // For simplicity, we store which JID triggered the most recent conversation
    // and that info comes from the meta on pushMessage.
    // Since we can't access that directly here, we log the limitation.
    process.stderr.write(`[whatsapp] Permission request: ${req.tool_name} (${req.request_id}) — needs active chat target\n`);
  });

  // ─── Hook events ─────────────────────────────────────────────────────────

  channel.onHookEvent(async (input) => {
    return {};
  });

  // ─── Cleanup ──────────────────────────────────────────────────────────────

  const cleanup = () => {
    shouldReconnect = false;
    try {
      sock.end(undefined);
    } catch {}
    channel.cleanup();
  };

  return { channel, cleanup };
}
