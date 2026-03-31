/**
 * send tool — Send a message to a target by UUID.
 * For human-friendly addressing (name, channel, chat ID), use reply instead.
 */
import type { ToolDefinition } from "./types.js";
import { sendToAgent } from "./agent-launcher.js";

export const sendTool: ToolDefinition = {
  name: "send",
  description: "Send a message to a target by UUID. Use reply for name/channel/chat-ID addressing.",
  inputSchema: {
    type: "object",
    properties: {
      target: { type: "string", description: "Target UUID." },
      text: { type: "string", description: "Message text" },
      format: { type: "string", description: "Message format (e.g. markdown, plain)" },
      files: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            url: { type: "string" },
            data: { type: "string" },
          },
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
          },
        },
        description: "Interactive buttons",
      },
      reply_to: { type: "string", description: "Message ID to reply to (threaded replies)" },
      tts: { type: "boolean", description: "Send as voice message (text-to-speech)" },
      tts_voice: { type: "string", description: "TTS voice name" },
    },
    required: ["target", "text"],
  },
  handle: async (args, ctx) => {
    const target = args.target as string;
    const text = args.text as string;

    const rich: Record<string, unknown> = {};
    if (args.format) rich.format = args.format;
    if (args.files) rich.files = args.files;
    if (args.buttons) rich.buttons = args.buttons;
    if (args.reply_to) rich.reply_to = args.reply_to;
    if (args.tts) rich.meta = { tts: "true", tts_voice: args.tts_voice };
    const content = Object.keys(rich).length ? JSON.stringify({ text, ...rich }) : text;

    // Resolve UUID via target registry
    const found = (ctx.hub as any).findTarget?.(target);
    if (found) {
      const rawId = found.rawId;
      if (found.kind === "agent") {
        const r = ctx.hub.sendMessage(rawId, content);
        return r.ok
          ? JSON.stringify({ sent: true, target, resolved: found.name, kind: "agent", uuid: found.uuid })
          : JSON.stringify(r);
      }
      const r = ctx.hub.reply(rawId, content);
      return r.ok
        ? JSON.stringify({ sent: true, target, resolved: found.name, kind: found.kind, uuid: found.uuid })
        : JSON.stringify(r);
    }

    // Try persistent agent
    const persistent = sendToAgent(target, text);
    if (persistent.sent) return JSON.stringify({ sent: true, target, via: "persistent_agent" });

    // Not found — report error
    return JSON.stringify({ sent: false, error: `UUID "${target}" not found. Use targets tool to list available UUIDs.` });
  },
};
