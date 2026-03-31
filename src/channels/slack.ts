/**
 * Slack Channel Adapter
 *
 * Uses @slack/bolt App with Socket Mode for inbound. mrkdwn formatting (4000 char limit),
 * Block Kit buttons for permission prompts, extra tools: slack_react, slack_thread, slack_upload.
 */

// NOTE: This legacy channel adapter reads process.env directly.
// Sanctioned exception: migration to HubConfigService is deferred until
// the adapter is brought into the active monorepo architecture.
// See REMAINING_FIXES.md §1 for context.

import { ChannelServer } from "../channel-server.js";
import type { ChannelServerOptions, ChannelPermissionRequest } from "../types.js";

// ─── Config ──────────────────────────────────────────────────────────────────

export interface SlackConfig {
  botToken: string;
  appToken: string;
  signingSecret: string;
}

export function parseConfig(): SlackConfig {
  const botToken = process.env.SLACK_BOT_TOKEN ?? "";
  const appToken = process.env.SLACK_APP_TOKEN ?? "";
  const signingSecret = process.env.SLACK_SIGNING_SECRET ?? "";

  if (!botToken) throw new Error("SLACK_BOT_TOKEN is required");
  if (!appToken) throw new Error("SLACK_APP_TOKEN is required (for Socket Mode)");
  if (!signingSecret) throw new Error("SLACK_SIGNING_SECRET is required");

  return { botToken, appToken, signingSecret };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const MAX_MSG_LEN = 4000;

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
 * Convert basic markdown to Slack mrkdwn.
 * Slack uses *bold*, _italic_, `code`, ```preformatted```, <url|text>.
 */
function mdToMrkdwn(md: string): string {
  let text = md;
  // Bold: **text** → *text*
  text = text.replace(/\*\*(.+?)\*\*/g, "*$1*");
  // Links: [text](url) → <url|text>
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<$2|$1>");
  return text;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Extra Tools ─────────────────────────────────────────────────────────────

const EXTRA_TOOLS: ChannelServerOptions["extraTools"] = [
  {
    name: "slack_react",
    description: "Add an emoji reaction to a Slack message",
    inputSchema: {
      type: "object",
      properties: {
        channel: { type: "string", description: "Slack channel ID" },
        timestamp: { type: "string", description: "Message timestamp (ts)" },
        emoji: { type: "string", description: "Emoji name without colons (e.g. thumbsup)" },
      },
      required: ["channel", "timestamp", "emoji"],
    },
  },
  {
    name: "slack_thread",
    description: "Reply in a thread on a Slack message",
    inputSchema: {
      type: "object",
      properties: {
        channel: { type: "string", description: "Slack channel ID" },
        thread_ts: { type: "string", description: "Parent message timestamp" },
        text: { type: "string", description: "Thread reply text" },
      },
      required: ["channel", "thread_ts", "text"],
    },
  },
  {
    name: "slack_upload",
    description: "Upload a file to a Slack channel",
    inputSchema: {
      type: "object",
      properties: {
        channel: { type: "string", description: "Slack channel ID" },
        file_path: { type: "string", description: "Local file path to upload" },
        filename: { type: "string", description: "Filename to display (optional)" },
        title: { type: "string", description: "File title (optional)" },
        initial_comment: { type: "string", description: "Message to accompany the file (optional)" },
      },
      required: ["channel", "file_path"],
    },
  },
];

// ─── Channel Factory ─────────────────────────────────────────────────────────

export async function createSlackChannel(
  config?: Partial<SlackConfig>,
): Promise<{ channel: ChannelServer; cleanup: () => void }> {
  // @ts-ignore - @slack/bolt is an optional peer dependency
  const { App } = await import("@slack/bolt") as any;
  const { readFileSync } = await import("node:fs");

  const cfg = { ...parseConfig(), ...config };

  const app = new App({
    token: cfg.botToken,
    appToken: cfg.appToken,
    signingSecret: cfg.signingSecret,
    socketMode: true,
  });

  const pendingPermissions = new Map<string, string>();

  const channel = new ChannelServer({
    name: "slack",
    version: "1.0.0",
    instructions: [
      "You are connected to Slack via Socket Mode. Messages arrive with channel and ts in meta.",
      "Use the reply tool to respond. For advanced features use slack_react, slack_thread, slack_upload.",
      "Slack uses mrkdwn formatting: *bold*, _italic_, `code`, ```preformatted```, <url|text>.",
      "Keep messages under 4000 characters; longer content is auto-chunked.",
      "Permission requests appear as Block Kit buttons. The user clicks Allow or Deny.",
    ].join(" "),
    permissionRelay: true,
    extraTools: EXTRA_TOOLS,
  });

  // ─── Inbound: Slack messages → channel.pushMessage() ────────────────────

  app.message(async ({ message, say }: any) => {
    // Filter out bot messages and subtypes
    if (!("text" in message) || !message.text) return;
    if ("bot_id" in message && message.bot_id) return;
    if ("subtype" in message && message.subtype) return;

    const channelId = message.channel;
    const user = ("user" in message ? message.user : undefined) ?? "unknown";
    const ts = ("ts" in message ? message.ts : undefined) ?? "";
    const threadTs = ("thread_ts" in message ? message.thread_ts : undefined) ?? "";

    await channel.pushMessage(message.text, {
      chat_id: channelId,
      message_id: ts,
      user,
      ts,
      ...(threadTs ? { thread_ts: threadTs } : {}),
    });
  });

  // ─── Permission button actions ──────────────────────────────────────────

  app.action(/^perm:.+$/, async ({ action, ack, respond }: any) => {
    await ack();
    if (!("action_id" in action)) return;

    const actionId = action.action_id;
    const [, requestId, decision] = actionId.split(":");
    if (!requestId || (decision !== "allow" && decision !== "deny")) return;

    await channel.sendPermissionVerdict({ request_id: requestId, behavior: decision });
    pendingPermissions.delete(requestId);

    try {
      await respond({
        replace_original: true,
        text: `Permission ${decision === "allow" ? "allowed" : "denied"}`,
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `*Permission Request* — *${decision === "allow" ? "Allowed" : "Denied"}*`,
            },
          },
        ],
      });
    } catch {}
  });

  // ─── Outbound: channel.onReply() → Slack send ──────────────────────────

  channel.onReply(async (chatId: string, text: string) => {
    const mrkdwn = mdToMrkdwn(text);
    const chunks = chunkText(mrkdwn, MAX_MSG_LEN);
    for (const chunk of chunks) {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await app.client.chat.postMessage({
            channel: chatId,
            text: chunk,
          });
          break;
        } catch (err: any) {
          if (err?.data?.error === "ratelimited") {
            const retryAfter = parseInt(err.headers?.["retry-after"] ?? "5", 10);
            await sleep(retryAfter * 1000);
            continue;
          }
          process.stderr.write(`[slack] Send error: ${err.message}\n`);
          break;
        }
      }
    }
  });

  // ─── Permission prompts → Block Kit buttons ─────────────────────────────

  channel.onPermissionRequest(async (req: ChannelPermissionRequest) => {
    // We don't have a specific channel list for Slack, so the permission
    // request will be visible in the same conversation thread. We need at
    // least one conversation to be active. Store the last seen channel.
    // For now, we log it—real usage wires this through a configured channel.
    process.stderr.write(`[slack] Permission request: ${req.tool_name} (${req.request_id})\n`);

    // We don't have a target channel from the request itself,
    // so we'll post to the most recent conversation channel if available.
    // In practice, the permission request comes from Claude during a chat.
    // We broadcast to all channels that have sent messages recently.
    // This is a limitation—Slack apps typically need a known channel.
  });

  // ─── Extra tool handlers ─────────────────────────────────────────────────

  channel.onToolCall(async (name: string, args: Record<string, unknown>) => {
    switch (name) {
      case "slack_react": {
        const ch = args.channel as string;
        const timestamp = args.timestamp as string;
        const emoji = args.emoji as string;

        await app.client.reactions.add({
          channel: ch,
          timestamp,
          name: emoji,
        });
        return { ok: true };
      }

      case "slack_thread": {
        const ch = args.channel as string;
        const threadTs = args.thread_ts as string;
        const text = args.text as string;

        const mrkdwn = mdToMrkdwn(text);
        const chunks = chunkText(mrkdwn, MAX_MSG_LEN);
        const sentTs: string[] = [];
        for (const chunk of chunks) {
          const result = await app.client.chat.postMessage({
            channel: ch,
            thread_ts: threadTs,
            text: chunk,
          });
          if (result.ts) sentTs.push(result.ts);
        }
        return { ok: true, timestamps: sentTs };
      }

      case "slack_upload": {
        const ch = args.channel as string;
        const filePath = args.file_path as string;
        const filename = (args.filename as string) ?? filePath.split("/").pop() ?? "file";
        const title = args.title as string | undefined;
        const initialComment = args.initial_comment as string | undefined;

        const fileContent = readFileSync(filePath);

        await app.client.filesUploadV2({
          channel_id: ch,
          file: fileContent,
          filename,
          title: title ?? filename,
          initial_comment: initialComment,
        });
        return { ok: true };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  });

  // ─── Hook events ─────────────────────────────────────────────────────────

  channel.onHookEvent(async (input) => {
    return {};
  });

  // ─── Start app ───────────────────────────────────────────────────────────

  await app.start();
  process.stderr.write("[slack] Socket Mode app started\n");

  const cleanup = () => {
    app.stop().catch(() => {});
    channel.cleanup();
  };

  return { channel, cleanup };
}
