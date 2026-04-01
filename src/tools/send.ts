/**
 * send tool — Send to a target UUID.
 *
 * UUID-only — no fallback. Use 'reply' tool for flexible identifiers (names, channels, etc).
 */
import type { ToolDefinition } from "./types.js";

export const sendTool: ToolDefinition = {
  name: "send",
  description: "Send a message to a target UUID. Use 'targets' tool to list available UUIDs. For names/channels, use 'reply' tool instead.",
  inputSchema: {
    type: "object",
    properties: {
      target: { type: "string", description: "Target UUID (from targets tool)" },
      text: { type: "string", description: "Message text" },
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
        description: "File attachments"
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
        description: "Interactive buttons"
      },
      reply_to: {
        type: "string",
        description: "Message ID to reply to (for threaded replies)"
      },
      tts: {
        type: "boolean",
        description: "Send as voice message (text-to-speech)"
      },
      tts_voice: {
        type: "string",
        description: "TTS voice name"
      }
    },
    required: ["target", "text"],
  },

  handle: async (args, ctx) => {
    const target = args.target as string;
    const text = args.text as string;

    const rich: Record<string, unknown> = {};
    if (args.format) rich.format = args.format as string;
    if (args.files) rich.files = args.files as any[];
    if (args.buttons) rich.buttons = args.buttons as any[];
    if (args.reply_to) rich.reply_to = args.reply_to as string;
    if (args.tts) rich.tts = args.tts as boolean;
    if (args.tts_voice) rich.tts_voice = args.tts_voice as string;
    const richOpts = Object.keys(rich).length ? rich : undefined;
    const content = richOpts ? JSON.stringify({ text, ...richOpts }) : text;

    // Resolve UUID via target registry - UUID ONLY
    const found = (ctx.hub as any).findTarget?.(target);
    if (!found) {
      return JSON.stringify({
        sent: false,
        error: `UUID "${target}" not found in registry. Use 'targets' tool to list available UUIDs.`
      });
    }

    const rawId = found.rawId;
    if (found.kind === "agent") {
      const r = ctx.hub.sendMessage(rawId, content);
      return r.ok
        ? JSON.stringify({ sent: true, target, resolved: found.name, kind: "agent" })
        : JSON.stringify(r);
    }
    const r = ctx.hub.reply(rawId, text, richOpts);
    return r.ok
      ? JSON.stringify({ sent: true, target, resolved: found.name, kind: found.kind })
      : JSON.stringify(r);
  },
};
