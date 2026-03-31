/**
 * Matrix Channel Adapter
 *
 * Uses matrix-js-sdk. Room timeline events for inbound, HTML formatted messages
 * with chunking, reaction emoji permission prompts, extra tools: matrix_react, matrix_room.
 */

// NOTE: This legacy channel adapter reads process.env directly.
// Sanctioned exception: migration to HubConfigService is deferred until
// the adapter is brought into the active monorepo architecture.
// See REMAINING_FIXES.md §1 for context.

import { ChannelServer } from "../channel-server.js";
import type { ChannelServerOptions, ChannelPermissionRequest } from "../types.js";

// ─── Config ──────────────────────────────────────────────────────────────────

export interface MatrixConfig {
  homeserver: string;
  accessToken: string;
  userId: string;
}

export function parseConfig(): MatrixConfig {
  const homeserver = process.env.MATRIX_HOMESERVER ?? "";
  const accessToken = process.env.MATRIX_ACCESS_TOKEN ?? "";
  const userId = process.env.MATRIX_USER_ID ?? "";

  if (!homeserver) throw new Error("MATRIX_HOMESERVER is required");
  if (!accessToken) throw new Error("MATRIX_ACCESS_TOKEN is required");
  if (!userId) throw new Error("MATRIX_USER_ID is required");

  return { homeserver, accessToken, userId };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const MAX_MSG_LEN = 16000; // Matrix doesn't have a strict limit, but chunk large messages

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
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, _lang, code) => `<pre><code>${escapeHtml(code.trimEnd())}</code></pre>`);
  html = html.replace(/`([^`]+)`/g, (_m, code) => `<code>${escapeHtml(code)}</code>`);
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/__(.+?)__/g, "<strong>$1</strong>");
  html = html.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "<em>$1</em>");
  html = html.replace(/(?<!_)_(?!_)(.+?)(?<!_)_(?!_)/g, "<em>$1</em>");
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  // Line breaks
  html = html.replace(/\n/g, "<br>");
  return html;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Extra Tools ─────────────────────────────────────────────────────────────

const EXTRA_TOOLS: ChannelServerOptions["extraTools"] = [
  {
    name: "matrix_react",
    description: "Add an emoji reaction to a Matrix message",
    inputSchema: {
      type: "object",
      properties: {
        room_id: { type: "string", description: "Matrix room ID" },
        event_id: { type: "string", description: "Event ID to react to" },
        emoji: { type: "string", description: "Emoji to react with" },
      },
      required: ["room_id", "event_id", "emoji"],
    },
  },
  {
    name: "matrix_room",
    description: "Create a new Matrix room or invite a user to a room",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["create", "invite"], description: "Action to perform" },
        room_name: { type: "string", description: "Room name (for create)" },
        room_id: { type: "string", description: "Room ID (for invite)" },
        user_id: { type: "string", description: "User ID to invite" },
        topic: { type: "string", description: "Room topic (for create)" },
      },
      required: ["action"],
    },
  },
];

// ─── Channel Factory ─────────────────────────────────────────────────────────

export async function createMatrixChannel(
  config?: Partial<MatrixConfig>,
): Promise<{ channel: ChannelServer; cleanup: () => void }> {
  // @ts-ignore - matrix-js-sdk is an optional peer dependency
  const sdk = await import("matrix-js-sdk") as any;

  const cfg = { ...parseConfig(), ...config };

  const client = sdk.createClient({
    baseUrl: cfg.homeserver,
    accessToken: cfg.accessToken,
    userId: cfg.userId,
  });

  // Track pending permissions: request_id -> { roomId, eventId }
  const pendingPermissions = new Map<string, { roomId: string; eventId: string }>();

  const channel = new ChannelServer({
    name: "matrix",
    version: "1.0.0",
    instructions: [
      "You are connected to Matrix. Messages arrive with room_id and event_id in meta.",
      "Use the reply tool to respond. For advanced features use matrix_react, matrix_room.",
      "Messages support HTML formatting. Large messages are auto-chunked.",
      "Permission requests appear as messages. The user reacts with a thumbs up or thumbs down emoji.",
    ].join(" "),
    permissionRelay: true,
    extraTools: EXTRA_TOOLS,
  });

  // ─── Inbound: Room timeline events → channel.pushMessage() ──────────────

  client.on("Room.timeline" as any, async (event: any, room: any) => {
    if (event.getType() !== "m.room.message") return;
    const sender = event.getSender();
    if (sender === cfg.userId) return; // Ignore own messages

    const content = event.getContent();
    const body = content.body;
    if (!body) return;

    const roomId = room.roomId;
    const eventId = event.getId();

    await channel.pushMessage(body, {
      chat_id: roomId,
      message_id: eventId,
      user: sender,
      room_name: room.name ?? roomId,
      ts: String(event.getTs()),
    });
  });

  // ─── Reaction events (for permission verdicts) ──────────────────────────

  client.on("Room.timeline" as any, async (event: any) => {
    if (event.getType() !== "m.reaction") return;

    const content = event.getContent();
    const relatesTo = content["m.relates_to"];
    if (!relatesTo) return;

    const targetEventId = relatesTo.event_id;
    const emoji = relatesTo.key;

    // Check if this reaction is for a pending permission
    for (const [reqId, pending] of pendingPermissions) {
      if (pending.eventId === targetEventId) {
        let decision: "allow" | "deny" | null = null;
        if (emoji === "\uD83D\uDC4D" || emoji === "\u2705") {
          decision = "allow";
        } else if (emoji === "\uD83D\uDC4E" || emoji === "\u274C") {
          decision = "deny";
        }

        if (decision) {
          await channel.sendPermissionVerdict({ request_id: reqId, behavior: decision });
          pendingPermissions.delete(reqId);

          try {
            await client.sendHtmlMessage(pending.roomId, `Permission ${decision}`, `<em>Permission ${decision}</em>`);
          } catch {}
        }
        break;
      }
    }
  });

  // ─── Outbound: channel.onReply() → Matrix send ─────────────────────────

  channel.onReply(async (chatId: string, text: string) => {
    const html = mdToHtml(text);
    const plainChunks = chunkText(text, MAX_MSG_LEN);
    const htmlChunks = chunkText(html, MAX_MSG_LEN);

    for (let i = 0; i < plainChunks.length; i++) {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await client.sendHtmlMessage(chatId, plainChunks[i], htmlChunks[i]);
          break;
        } catch (err: any) {
          if (err?.httpStatus === 429) {
            const retryAfter = err.data?.retry_after_ms ?? 5000;
            await sleep(retryAfter);
            continue;
          }
          process.stderr.write(`[matrix] Send error: ${err.message}\n`);
          break;
        }
      }
    }
  });

  // ─── Permission prompts → reaction-based ────────────────────────────────

  channel.onPermissionRequest(async (req: ChannelPermissionRequest) => {
    // Get all joined rooms
    const rooms = client.getRooms();
    if (rooms.length === 0) {
      process.stderr.write("[matrix] No joined rooms for permission prompt\n");
      return;
    }

    const message = [
      "**Permission Request**",
      "",
      `**Tool:** \`${req.tool_name}\``,
      `**Description:** ${req.description}`,
      "",
      "```",
      req.input_preview.slice(0, 3000),
      "```",
      "",
      "React with a thumbs up to allow or thumbs down to deny.",
    ].join("\n");

    const htmlMessage = mdToHtml(message);

    // Send to the first joined room (in production, you'd pick the active conversation room)
    const targetRoom = rooms[0];
    try {
      const result = await client.sendHtmlMessage(targetRoom.roomId, message, htmlMessage);
      pendingPermissions.set(req.request_id, {
        roomId: targetRoom.roomId,
        eventId: result.event_id,
      });
    } catch (err: any) {
      process.stderr.write(`[matrix] Permission prompt error: ${err.message}\n`);
    }
  });

  // ─── Extra tool handlers ─────────────────────────────────────────────────

  channel.onToolCall(async (name: string, args: Record<string, unknown>) => {
    switch (name) {
      case "matrix_react": {
        const roomId = args.room_id as string;
        const eventId = args.event_id as string;
        const emoji = args.emoji as string;

        await client.sendEvent(roomId, "m.reaction", {
          "m.relates_to": {
            rel_type: "m.annotation",
            event_id: eventId,
            key: emoji,
          },
        });
        return { ok: true };
      }

      case "matrix_room": {
        const action = args.action as string;

        if (action === "create") {
          const roomName = args.room_name as string | undefined;
          const topic = args.topic as string | undefined;
          const result = await client.createRoom({
            name: roomName,
            topic,
            visibility: "private" as any,
          });
          return { ok: true, room_id: result.room_id };
        }

        if (action === "invite") {
          const roomId = args.room_id as string;
          const userId = args.user_id as string;
          await client.invite(roomId, userId);
          return { ok: true };
        }

        throw new Error(`Unknown matrix_room action: ${action}`);
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  });

  // ─── Hook events ─────────────────────────────────────────────────────────

  channel.onHookEvent(async (input) => {
    return {};
  });

  // ─── Start client ────────────────────────────────────────────────────────

  await client.startClient({ initialSyncLimit: 10 });
  process.stderr.write("[matrix] Client started\n");

  const cleanup = () => {
    client.stopClient();
    channel.cleanup();
  };

  return { channel, cleanup };
}
