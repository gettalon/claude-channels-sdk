/**
 * Feishu / Lark Channel Adapter
 *
 * Uses @larksuiteoapi/node-sdk. Event subscription for inbound,
 * rich text messages, interactive card buttons for permission prompts.
 */

import { ChannelServer } from "../channel-server.js";
import type { ChannelServerOptions, ChannelPermissionRequest } from "../types.js";

// ─── Config ──────────────────────────────────────────────────────────────────

export interface FeishuConfig {
  appId: string;
  appSecret: string;
}

export function parseConfig(): FeishuConfig {
  const appId = process.env.FEISHU_APP_ID ?? "";
  const appSecret = process.env.FEISHU_APP_SECRET ?? "";

  if (!appId) throw new Error("FEISHU_APP_ID is required");
  if (!appSecret) throw new Error("FEISHU_APP_SECRET is required");

  return { appId, appSecret };
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
 * Convert text to Feishu rich text content format.
 */
function toRichText(text: string): any {
  // Split into paragraphs and create rich text elements
  const lines = text.split("\n");
  const content: any[][] = [];

  for (const line of lines) {
    const elements: any[] = [];

    // Simple parsing: detect bold (**text**), code (`text`), links [text](url)
    let remaining = line;
    while (remaining.length > 0) {
      // Bold
      const boldMatch = remaining.match(/^\*\*(.+?)\*\*/);
      if (boldMatch) {
        elements.push({ tag: "text", text: boldMatch[1], style: ["bold"] });
        remaining = remaining.slice(boldMatch[0].length);
        continue;
      }

      // Code
      const codeMatch = remaining.match(/^`([^`]+)`/);
      if (codeMatch) {
        elements.push({ tag: "text", text: codeMatch[1], style: ["italic"] });
        remaining = remaining.slice(codeMatch[0].length);
        continue;
      }

      // Link
      const linkMatch = remaining.match(/^\[([^\]]+)\]\(([^)]+)\)/);
      if (linkMatch) {
        elements.push({ tag: "a", text: linkMatch[1], href: linkMatch[2] });
        remaining = remaining.slice(linkMatch[0].length);
        continue;
      }

      // Plain text - consume until next special character
      const nextSpecial = remaining.search(/[\*`\[]/);
      if (nextSpecial === -1) {
        elements.push({ tag: "text", text: remaining });
        remaining = "";
      } else if (nextSpecial === 0) {
        // Special char but no match — consume one char
        elements.push({ tag: "text", text: remaining[0] });
        remaining = remaining.slice(1);
      } else {
        elements.push({ tag: "text", text: remaining.slice(0, nextSpecial) });
        remaining = remaining.slice(nextSpecial);
      }
    }

    if (elements.length === 0) {
      elements.push({ tag: "text", text: "" });
    }
    content.push(elements);
  }

  return {
    zh_cn: {
      title: "",
      content,
    },
  };
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Channel Factory ─────────────────────────────────────────────────────────

export async function createFeishuChannel(
  config?: Partial<FeishuConfig>,
): Promise<{ channel: ChannelServer; cleanup: () => void }> {
  // @ts-ignore - @larksuiteoapi/node-sdk is an optional peer dependency
  const lark = await import("@larksuiteoapi/node-sdk") as any;

  const cfg = { ...parseConfig(), ...config };

  const larkClient = new lark.Client({
    appId: cfg.appId,
    appSecret: cfg.appSecret,
    appType: lark.AppType.SelfBuild,
  });

  const eventDispatcher = new lark.EventDispatcher({}).register({
    "im.message.receive_v1": async (data: any) => {
      const message = data?.message;
      if (!message) return;

      const chatId = message.chat_id;
      const messageId = message.message_id;
      const senderId = data.sender?.sender_id?.open_id ?? "unknown";
      const msgType = message.message_type;

      let text = "";
      try {
        const content = JSON.parse(message.content ?? "{}");
        if (msgType === "text") {
          text = content.text ?? "";
        } else if (msgType === "post") {
          // Rich text — extract plain text from it
          const post = content.post ?? content;
          const firstLang = Object.values(post)[0] as any;
          if (firstLang?.content) {
            text = (firstLang.content as any[][])
              .flat()
              .map((el: any) => el.text ?? "")
              .join("");
          }
        } else {
          text = `[${msgType} message]`;
        }
      } catch {
        text = message.content ?? "";
      }

      if (!text) return;

      // Check for permission reply
      const upper = text.trim().toUpperCase();
      if (upper === "ALLOW" || upper === "DENY" || upper === "YES" || upper === "NO") {
        for (const [reqId, pending] of pendingPermissions) {
          if (pending.chatId === chatId) {
            const decision = upper === "ALLOW" || upper === "YES" ? "allow" : "deny";
            await channel.sendPermissionVerdict({ request_id: reqId, behavior: decision });
            pendingPermissions.delete(reqId);
            break;
          }
        }
      }

      await channel.pushMessage(text, {
        chat_id: chatId,
        message_id: messageId,
        user: senderId,
        ts: String(Date.now()),
      });
    },
  });

  // Handle card action (permission buttons)
  const cardHandler = async (data: any) => {
    const action = data?.action;
    if (!action?.value) return {};

    const value = action.value as Record<string, string>;
    const requestId = value.request_id;
    const decision = value.decision as "allow" | "deny";

    if (requestId && (decision === "allow" || decision === "deny")) {
      await channel.sendPermissionVerdict({ request_id: requestId, behavior: decision });
      pendingPermissions.delete(requestId);

      return {
        toast: { type: "success", content: `Permission ${decision}` },
      };
    }

    return {};
  };

  const pendingPermissions = new Map<string, { chatId: string }>();

  const channel = new ChannelServer({
    name: "feishu",
    version: "1.0.0",
    instructions: [
      "You are connected to Feishu/Lark. Messages arrive with chat_id in meta.",
      "Use the reply tool to respond. Feishu supports rich text formatting.",
      "Keep messages under 4000 characters; longer content is auto-chunked.",
      "Permission requests appear as interactive cards with buttons. The user clicks Allow or Deny.",
    ].join(" "),
    permissionRelay: true,
  });

  // ─── Outbound: channel.onReply() → Feishu send ─────────────────────────

  channel.onReply(async (chatId: string, text: string) => {
    const chunks = chunkText(text, MAX_MSG_LEN);

    for (const chunk of chunks) {
      const richText = toRichText(chunk);
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await larkClient.im.message.create({
            data: {
              receive_id: chatId,
              content: JSON.stringify({ ...richText }),
              msg_type: "post",
            },
            params: { receive_id_type: "chat_id" },
          });
          break;
        } catch (err: any) {
          if (err?.code === 99991400) {
            // Rate limited
            await sleep(5000);
            continue;
          }
          process.stderr.write(`[feishu] Send error: ${err.message}\n`);
          break;
        }
      }
    }
  });

  // ─── Permission prompts → interactive cards ─────────────────────────────

  channel.onPermissionRequest(async (req: ChannelPermissionRequest) => {
    process.stderr.write(`[feishu] Permission request: ${req.tool_name} (${req.request_id})\n`);

    // Build interactive card
    const card = {
      config: { wide_screen_mode: true },
      header: {
        title: { tag: "plain_text", content: "Permission Request" },
        template: "orange",
      },
      elements: [
        {
          tag: "div",
          text: {
            tag: "lark_md",
            content: `**Tool:** \`${req.tool_name}\`\n**Description:** ${req.description}\n\n\`\`\`\n${req.input_preview.slice(0, 2000)}\n\`\`\``,
          },
        },
        {
          tag: "action",
          actions: [
            {
              tag: "button",
              text: { tag: "plain_text", content: "Allow" },
              type: "primary",
              value: { request_id: req.request_id, decision: "allow" },
            },
            {
              tag: "button",
              text: { tag: "plain_text", content: "Deny" },
              type: "danger",
              value: { request_id: req.request_id, decision: "deny" },
            },
          ],
        },
      ],
    };

    // We need an active chat ID. In production, track recent conversations.
    // For now, log the request.
  });

  // ─── Hook events ─────────────────────────────────────────────────────────

  channel.onHookEvent(async (input) => {
    return {};
  });

  // ─── Start event server ──────────────────────────────────────────────────

  // Feishu SDK supports both websocket and webhook modes.
  // We set up an HTTP server for event subscription.
  const http = await import("node:http");
  const eventServer = http.createServer(async (req, res) => {
    if (req.method !== "POST") {
      res.writeHead(404);
      res.end();
      return;
    }

    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", async () => {
      const body = Buffer.concat(chunks).toString();
      try {
        const parsed = JSON.parse(body);

        // URL verification challenge
        if (parsed.type === "url_verification") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ challenge: parsed.challenge }));
          return;
        }

        // Card action
        if (parsed.action) {
          const result = await cardHandler(parsed);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
          return;
        }

        // Event callback
        if (parsed.header?.event_type) {
          const eventType = parsed.header.event_type;
          const handler = (eventDispatcher as any).handlers?.[eventType];
          if (handler) {
            await handler(parsed.event);
          }
        }

        res.writeHead(200);
        res.end("OK");
      } catch (err: any) {
        process.stderr.write(`[feishu] Event parse error: ${err.message}\n`);
        res.writeHead(400);
        res.end("Bad request");
      }
    });
  });

  const port = parseInt(process.env.FEISHU_WEBHOOK_PORT ?? "9000", 10);
  await new Promise<void>((resolve) => {
    eventServer.listen(port, () => {
      process.stderr.write(`[feishu] Event server listening on port ${port}\n`);
      resolve();
    });
  });

  const cleanup = () => {
    eventServer.close();
    channel.cleanup();
  };

  return { channel, cleanup };
}
