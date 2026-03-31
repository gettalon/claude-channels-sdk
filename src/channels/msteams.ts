/**
 * Microsoft Teams Channel Adapter
 *
 * Uses botbuilder (Bot Framework SDK). Activity handler for inbound,
 * Adaptive Cards for messages and permission prompts.
 */

// NOTE: This legacy channel adapter reads process.env directly.
// Sanctioned exception: migration to HubConfigService is deferred until
// the adapter is brought into the active monorepo architecture.
// See REMAINING_FIXES.md §1 for context.

import { ChannelServer } from "../channel-server.js";
import type { ChannelServerOptions, ChannelPermissionRequest } from "../types.js";

// ─── Config ──────────────────────────────────────────────────────────────────

export interface TeamsConfig {
  appId: string;
  appPassword: string;
  port?: number;
}

export function parseConfig(): TeamsConfig {
  const appId = process.env.TEAMS_APP_ID ?? "";
  const appPassword = process.env.TEAMS_APP_PASSWORD ?? "";
  const port = parseInt(process.env.TEAMS_PORT ?? "3978", 10);

  if (!appId) throw new Error("TEAMS_APP_ID is required");
  if (!appPassword) throw new Error("TEAMS_APP_PASSWORD is required");

  return { appId, appPassword, port };
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

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function mdToHtml(md: string): string {
  let html = md;
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, _lang, code) => `<pre>${escapeHtml(code.trimEnd())}</pre>`);
  html = html.replace(/`([^`]+)`/g, (_m, code) => `<code>${escapeHtml(code)}</code>`);
  html = html.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  html = html.replace(/__(.+?)__/g, "<b>$1</b>");
  html = html.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "<i>$1</i>");
  html = html.replace(/(?<!_)_(?!_)(.+?)(?<!_)_(?!_)/g, "<i>$1</i>");
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  html = html.replace(/\n/g, "<br>");
  return html;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Channel Factory ─────────────────────────────────────────────────────────

export async function createTeamsChannel(
  config?: Partial<TeamsConfig>,
): Promise<{ channel: ChannelServer; cleanup: () => void }> {
  // @ts-ignore - botbuilder is an optional peer dependency
  const _botbuilder = await import("botbuilder");
  const { BotFrameworkAdapter, ActivityHandler, CardFactory, MessageFactory, TurnContext } = _botbuilder as any;

  const cfg = { ...parseConfig(), ...config };

  const adapter = new BotFrameworkAdapter({
    appId: cfg.appId,
    appPassword: cfg.appPassword,
  });

  adapter.onTurnError = async (context: any, error: any) => {
    process.stderr.write(`[teams] Turn error: ${error.message}\n`);
    await context.sendActivity("An error occurred. Please try again.");
  };

  // Store conversation references for proactive messaging
  const conversationRefs = new Map<string, any>();
  const pendingPermissions = new Map<string, { conversationId: string }>();

  const channel = new ChannelServer({
    name: "msteams",
    version: "1.0.0",
    instructions: [
      "You are connected to Microsoft Teams. Messages arrive with conversation_id in meta.",
      "Use the reply tool to respond. Teams supports HTML and Adaptive Cards.",
      "Keep messages under 4000 characters; longer content is auto-chunked.",
      "Permission requests appear as Adaptive Card buttons. The user clicks Allow or Deny.",
    ].join(" "),
    permissionRelay: true,
  });

  // ─── Bot handler ─────────────────────────────────────────────────────────

  class ChannelBot extends ActivityHandler {
    constructor() {
      super();

      this.onMessage(async (context: any, next: any) => {
        // Store conversation reference for proactive messaging
        const ref = TurnContext.getConversationReference(context.activity);
        const conversationId = context.activity.conversation.id;
        conversationRefs.set(conversationId, ref);

        const text = context.activity.text ?? "";
        const user = context.activity.from?.name ?? context.activity.from?.id ?? "unknown";

        // Handle Adaptive Card action (permission verdict)
        if (context.activity.value) {
          const value = context.activity.value as Record<string, string>;
          if (value.action === "permission_verdict" && value.request_id) {
            const decision = value.decision as "allow" | "deny";
            if (decision === "allow" || decision === "deny") {
              await channel.sendPermissionVerdict({ request_id: value.request_id, behavior: decision });
              pendingPermissions.delete(value.request_id);
              await context.sendActivity(`Permission ${decision}.`);
              await next();
              return;
            }
          }
        }

        if (text) {
          await channel.pushMessage(text, {
            chat_id: conversationId,
            user,
            message_id: context.activity.id ?? "",
            ts: String(Date.now()),
          });
        }

        await next();
      });

      this.onMembersAdded(async (context: any, next: any) => {
        for (const member of context.activity.membersAdded ?? []) {
          if (member.id !== context.activity.recipient.id) {
            await context.sendActivity("Hello! I'm connected to Claude Code.");
          }
        }
        await next();
      });
    }
  }

  const bot = new ChannelBot();

  // ─── Outbound: channel.onReply() → Teams send ──────────────────────────

  channel.onReply(async (chatId: string, text: string) => {
    const ref = conversationRefs.get(chatId);
    if (!ref) {
      process.stderr.write(`[teams] No conversation reference for ${chatId}\n`);
      return;
    }

    const html = mdToHtml(text);
    const chunks = chunkText(html, MAX_MSG_LEN);

    for (const chunk of chunks) {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await adapter.continueConversation(ref, async (context: any) => {
            await context.sendActivity(MessageFactory.text(chunk));
          });
          break;
        } catch (err: any) {
          if (err?.statusCode === 429) {
            await sleep(5000);
            continue;
          }
          process.stderr.write(`[teams] Send error: ${err.message}\n`);
          break;
        }
      }
    }
  });

  // ─── Permission prompts → Adaptive Cards ────────────────────────────────

  channel.onPermissionRequest(async (req: ChannelPermissionRequest) => {
    process.stderr.write(`[teams] Permission request: ${req.tool_name} (${req.request_id})\n`);

    // Send to all known conversations
    for (const [conversationId, ref] of conversationRefs) {
      try {
        await adapter.continueConversation(ref, async (context: any) => {
          const card = CardFactory.adaptiveCard({
            type: "AdaptiveCard",
            version: "1.3",
            body: [
              {
                type: "TextBlock",
                text: "Permission Request",
                weight: "bolder",
                size: "large",
              },
              {
                type: "FactSet",
                facts: [
                  { title: "Tool", value: req.tool_name },
                  { title: "Description", value: req.description },
                ],
              },
              {
                type: "TextBlock",
                text: req.input_preview.slice(0, 1500),
                wrap: true,
                fontType: "monospace",
                size: "small",
              },
            ],
            actions: [
              {
                type: "Action.Submit",
                title: "Allow",
                style: "positive",
                data: {
                  action: "permission_verdict",
                  request_id: req.request_id,
                  decision: "allow",
                },
              },
              {
                type: "Action.Submit",
                title: "Deny",
                style: "destructive",
                data: {
                  action: "permission_verdict",
                  request_id: req.request_id,
                  decision: "deny",
                },
              },
            ],
          });

          await context.sendActivity({ attachments: [card] });
          pendingPermissions.set(req.request_id, { conversationId });
        });
      } catch (err: any) {
        process.stderr.write(`[teams] Permission prompt error: ${err.message}\n`);
      }
    }
  });

  // ─── Hook events ─────────────────────────────────────────────────────────

  channel.onHookEvent(async (input) => {
    return {};
  });

  // ─── Start HTTP server ────────────────────────────────────────────────────

  const http = await import("node:http");
  const server = http.createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/api/messages") {
      res.writeHead(404);
      res.end();
      return;
    }

    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", async () => {
      const body = Buffer.concat(chunks).toString();
      try {
        // Create a mock request/response for the adapter
        const mockReq = {
          body: JSON.parse(body),
          headers: req.headers,
          method: req.method,
          on: req.on.bind(req),
        };

        await adapter.process(mockReq as any, res as any, async (context: any) => {
          await bot.run(context);
        });
      } catch (err: any) {
        process.stderr.write(`[teams] Request error: ${err.message}\n`);
        res.writeHead(500);
        res.end("Internal Server Error");
      }
    });
  });

  const port = cfg.port ?? 3978;
  await new Promise<void>((resolve) => {
    server.listen(port, () => {
      process.stderr.write(`[teams] Bot server listening on port ${port}\n`);
      resolve();
    });
  });

  const cleanup = () => {
    server.close();
    channel.cleanup();
  };

  return { channel, cleanup };
}
