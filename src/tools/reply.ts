/**
 * reply tool — Reply to a chat or send to any addressable target.
 * Accepts name, channel, agent, raw chat ID, or UUID.
 */
import type { ToolDefinition } from "./types.js";
import { sendToAgent } from "./agent-launcher.js";

export const replyTool: ToolDefinition = {
  name: "reply",
  description: "Reply to a chat or send to any addressable target. Accepts name, channel, agent, raw chat ID, or UUID.",
  inputSchema: {
    type: "object",
    properties: {
      chat_id: { type: "string", description: "Target to reply to — name, channel, agent, raw chat ID, or UUID. Hub resolves automatically. (e.g. telegram, test-9091, Home Claude, echo-bot, or a UUID)" },
      text: { type: "string", description: "Reply text" },
      format: { type: "string", enum: ["text", "markdown", "html"], description: "Message format" },
      files: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            path: { type: "string" },
            data: { type: "string" },
            url: { type: "string" },
            mime: { type: "string" },
          },
          required: ["name"],
        },
        description: "File attachments",
      },
      buttons: {
        type: "array",
        items: {
          type: "object",
          properties: {
            text: { type: "string" },
            action: { type: "string" },
            url: { type: "string" },
          },
          required: ["text"],
        },
        description: "Interactive buttons",
      },
      reply_to: { type: "string", description: "Message ID to reply to (threaded replies)" },
      tts: { type: "boolean", description: "Send as voice message (text-to-speech)" },
      tts_voice: { type: "string", description: "TTS voice name (auto-detects language if omitted)" },
    },
    required: ["chat_id", "text"],
  },
  handle: async (args, ctx) => {
    const target = args.chat_id as string;
    const text = args.text as string;

    const rich: Record<string, unknown> = {};
    if (args.format) rich.format = args.format;
    if (args.files) rich.files = args.files;
    if (args.buttons) rich.buttons = args.buttons;
    if (args.reply_to) rich.reply_to = args.reply_to;
    if (args.tts) rich.meta = { tts: "true", tts_voice: args.tts_voice };
    const richOpts = Object.keys(rich).length ? rich as any : undefined;
    const content = richOpts ? JSON.stringify({ text, ...rich }) : text;

    // 1. Resolve via unified target registry (UUID or name)
    const found = (ctx.hub as any).findTarget?.(target);
    if (found) {
      const rawId = found.rawId;
      if (found.kind === "agent") {
        const r = ctx.hub.sendMessage(rawId, content);
        return r.ok ? "sent" : JSON.stringify(r);
      }
      const r = ctx.hub.reply(rawId, text, richOpts);
      return r.ok ? "sent" : JSON.stringify(r);
    }

    // 2. Try persistent agent input queue
    const persistent = sendToAgent(target, text);
    if (persistent.sent) return "sent";

    // 3. Fall back to hub reply (handles chat routes, contacts, etc.)
    const r = ctx.hub.reply(target, text, richOpts);
    return r.ok ? "sent" : JSON.stringify(r);
  },
};
