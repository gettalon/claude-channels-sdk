/**
 * IRC Channel Adapter
 *
 * Uses irc-framework. PRIVMSG for inbound, plain text with 512 byte line limit,
 * text-based permission prompts (reply YES/NO).
 */

import { ChannelServer } from "../channel-server.js";
import type { ChannelPermissionRequest } from "../types.js";

// ─── Config ──────────────────────────────────────────────────────────────────

export interface IrcConfig {
  server: string;
  port: number;
  nick: string;
  channels: string[];
  password?: string;
  tls?: boolean;
}

export function parseConfig(): IrcConfig {
  const server = process.env.IRC_SERVER ?? "";
  const port = parseInt(process.env.IRC_PORT ?? "6667", 10);
  const nick = process.env.IRC_NICK ?? "";
  const channels = (process.env.IRC_CHANNELS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const password = process.env.IRC_PASSWORD;
  const tls = process.env.IRC_TLS === "true";

  if (!server) throw new Error("IRC_SERVER is required");
  if (!nick) throw new Error("IRC_NICK is required");
  if (channels.length === 0) throw new Error("IRC_CHANNELS is required (comma-separated)");

  return { server, port, nick, channels, password, tls };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

// IRC messages must be under 512 bytes total (including CRLF).
// PRIVMSG #channel :text\r\n overhead is ~30-50 bytes. Use 400 as safe text limit.
const MAX_LINE_BYTES = 400;

function chunkByBytes(text: string, limit: number): string[] {
  const lines = text.split("\n");
  const chunks: string[] = [];

  for (const line of lines) {
    const encoded = Buffer.from(line, "utf-8");
    if (encoded.length <= limit) {
      chunks.push(line);
    } else {
      // Split long lines by words
      const words = line.split(" ");
      let current = "";
      for (const word of words) {
        const test = current ? `${current} ${word}` : word;
        if (Buffer.from(test, "utf-8").length > limit) {
          if (current) chunks.push(current);
          // If a single word exceeds limit, force-split it
          if (Buffer.from(word, "utf-8").length > limit) {
            let remaining = word;
            while (Buffer.from(remaining, "utf-8").length > limit) {
              // Binary search for safe split point
              let end = limit;
              while (Buffer.from(remaining.slice(0, end), "utf-8").length > limit) end--;
              chunks.push(remaining.slice(0, end));
              remaining = remaining.slice(end);
            }
            current = remaining;
          } else {
            current = word;
          }
        } else {
          current = test;
        }
      }
      if (current) chunks.push(current);
    }
  }

  return chunks.filter((c) => c.length > 0);
}

function stripMarkdown(md: string): string {
  let text = md;
  text = text.replace(/```[\s\S]*?```/g, (m) => m.replace(/```\w*\n?/g, "").replace(/```/g, ""));
  text = text.replace(/`([^`]+)`/g, "$1");
  text = text.replace(/\*\*(.+?)\*\*/g, "$1");
  text = text.replace(/__(.+?)__/g, "$1");
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)");
  return text;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Channel Factory ─────────────────────────────────────────────────────────

export async function createIrcChannel(
  config?: Partial<IrcConfig>,
): Promise<{ channel: ChannelServer; cleanup: () => void }> {
  // @ts-ignore - irc-framework is an optional peer dependency
  const ircFramework = await import("irc-framework") as any;

  const cfg = { ...parseConfig(), ...config };

  const ircClient = new ircFramework.Client();
  const pendingPermissions = new Map<string, string>(); // request_id -> nick or channel

  const channel = new ChannelServer({
    name: "irc",
    version: "1.0.0",
    instructions: [
      "You are connected to IRC. Messages arrive with chat_id (channel or nick) in meta.",
      "Use the reply tool to respond. IRC is plain text only.",
      "Messages are limited to ~400 bytes per line. Longer content is auto-chunked into multiple lines.",
      "Permission requests are sent as text. The user replies YES or NO.",
    ].join(" "),
    permissionRelay: true,
  });

  // ─── Inbound: PRIVMSG → channel.pushMessage() ──────────────────────────

  ircClient.on("privmsg", (event: any) => {
    const nick = event.nick;
    const target = event.target;
    const text = event.message;
    const isChannel = target.startsWith("#") || target.startsWith("&");
    const chatId = isChannel ? target : nick;

    // Check for permission reply
    const upper = text.trim().toUpperCase();
    if (upper === "YES" || upper === "NO") {
      for (const [reqId, pendingTarget] of pendingPermissions) {
        if (pendingTarget === nick || pendingTarget === chatId) {
          const decision = upper === "YES" ? "allow" : "deny";
          channel.sendPermissionVerdict({ request_id: reqId, behavior: decision }).catch(() => {});
          pendingPermissions.delete(reqId);
          ircClient.say(chatId, `Permission ${decision}.`);
          break;
        }
      }
    }

    channel.pushMessage(text, {
      chat_id: chatId,
      user: nick,
      is_channel: String(isChannel),
      ts: String(Date.now()),
    }).catch((err) => {
      process.stderr.write(`[irc] pushMessage error: ${err.message}\n`);
    });
  });

  // ─── Outbound: channel.onReply() → IRC send ────────────────────────────

  channel.onReply(async (chatId: string, text: string) => {
    const plain = stripMarkdown(text);
    const chunks = chunkByBytes(plain, MAX_LINE_BYTES);

    for (let i = 0; i < chunks.length; i++) {
      ircClient.say(chatId, chunks[i]);
      // Rate limit: don't flood the server
      if (i < chunks.length - 1) {
        await sleep(500);
      }
    }
  });

  // ─── Permission prompts → text ──────────────────────────────────────────

  channel.onPermissionRequest(async (req: ChannelPermissionRequest) => {
    const target = cfg.channels[0]; // Send to first configured channel
    if (!target) {
      process.stderr.write("[irc] No target for permission prompt\n");
      return;
    }

    const lines = [
      "--- PERMISSION REQUEST ---",
      `Tool: ${req.tool_name}`,
      `Description: ${req.description}`,
      req.input_preview.slice(0, 300),
      "Reply YES to allow or NO to deny.",
    ];

    for (const line of lines) {
      ircClient.say(target, line);
      await sleep(500);
    }

    pendingPermissions.set(req.request_id, target);
  });

  // ─── Hook events ─────────────────────────────────────────────────────────

  channel.onHookEvent(async (input) => {
    return {};
  });

  // ─── Connect ──────────────────────────────────────────────────────────────

  await new Promise<void>((resolve, reject) => {
    ircClient.on("registered", () => {
      process.stderr.write(`[irc] Connected as ${cfg.nick}\n`);
      for (const ch of cfg.channels) {
        ircClient.join(ch);
        process.stderr.write(`[irc] Joining ${ch}\n`);
      }
      resolve();
    });

    ircClient.on("error", (err: any) => {
      process.stderr.write(`[irc] Error: ${err.message ?? JSON.stringify(err)}\n`);
    });

    ircClient.on("close", () => {
      process.stderr.write("[irc] Connection closed\n");
    });

    ircClient.connect({
      host: cfg.server,
      port: cfg.port,
      nick: cfg.nick,
      password: cfg.password,
      tls: cfg.tls ?? false,
    });

    // Timeout for connection
    setTimeout(() => reject(new Error("IRC connection timeout")), 30_000);
  });

  const cleanup = () => {
    ircClient.quit("Channel shutting down");
    channel.cleanup();
  };

  return { channel, cleanup };
}
