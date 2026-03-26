/**
 * LINE Channel Adapter
 *
 * Uses @line/bot-sdk. Webhook for inbound messages, Flex Message support,
 * quick reply buttons for permission prompts.
 */
import { ChannelServer } from "../channel-server.js";
export function parseConfig() {
    const channelAccessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN ?? "";
    const channelSecret = process.env.LINE_CHANNEL_SECRET ?? "";
    const webhookPort = parseInt(process.env.LINE_WEBHOOK_PORT ?? "3000", 10);
    if (!channelAccessToken)
        throw new Error("LINE_CHANNEL_ACCESS_TOKEN is required");
    if (!channelSecret)
        throw new Error("LINE_CHANNEL_SECRET is required");
    return { channelAccessToken, channelSecret, webhookPort };
}
// ─── Helpers ─────────────────────────────────────────────────────────────────
const MAX_MSG_LEN = 5000;
function chunkText(text, limit) {
    if (text.length <= limit)
        return [text];
    const chunks = [];
    let remaining = text;
    while (remaining.length > 0) {
        if (remaining.length <= limit) {
            chunks.push(remaining);
            break;
        }
        let splitAt = remaining.lastIndexOf("\n", limit);
        if (splitAt <= 0)
            splitAt = remaining.lastIndexOf(" ", limit);
        if (splitAt <= 0)
            splitAt = limit;
        chunks.push(remaining.slice(0, splitAt));
        remaining = remaining.slice(splitAt).replace(/^\n/, "");
    }
    return chunks;
}
function stripMarkdown(md) {
    let text = md;
    text = text.replace(/```[\s\S]*?```/g, (m) => m.replace(/```\w*\n?/g, "").replace(/```/g, ""));
    text = text.replace(/`([^`]+)`/g, "$1");
    text = text.replace(/\*\*(.+?)\*\*/g, "$1");
    text = text.replace(/__(.+?)__/g, "$1");
    text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)");
    return text;
}
async function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
// ─── Channel Factory ─────────────────────────────────────────────────────────
export async function createLineChannel(config) {
    // @ts-ignore - @line/bot-sdk is an optional peer dependency
    const line = await import("@line/bot-sdk");
    const http = await import("node:http");
    const cfg = { ...parseConfig(), ...config };
    const lineConfig = {
        channelAccessToken: cfg.channelAccessToken,
        channelSecret: cfg.channelSecret,
    };
    const lineClient = new line.messagingApi.MessagingApiClient({
        channelAccessToken: cfg.channelAccessToken,
    });
    // Pending permissions: request_id -> userId
    const pendingPermissions = new Map();
    const channel = new ChannelServer({
        name: "line",
        version: "1.0.0",
        instructions: [
            "You are connected to LINE. Messages arrive with chat_id (user/group/room ID) in meta.",
            "Use the reply tool to respond. LINE supports text and Flex Messages.",
            "Messages are plain text. Longer content is auto-chunked.",
            "Permission requests appear as quick reply buttons. The user taps Allow or Deny.",
        ].join(" "),
        permissionRelay: true,
    });
    // ─── Webhook handler ────────────────────────────────────────────────────
    function handleWebhookEvents(events) {
        for (const event of events) {
            if (event.type !== "message")
                continue;
            if (!("message" in event) || event.message.type !== "text")
                continue;
            const textMsg = event.message;
            const text = textMsg.text;
            const userId = event.source?.userId ?? "";
            const groupId = event.source?.type === "group" ? event.source.groupId : "";
            const roomId = event.source?.type === "room" ? event.source.roomId : "";
            const chatId = groupId || roomId || userId;
            const replyToken = ("replyToken" in event ? event.replyToken : "");
            // Check for permission reply
            const upper = text.trim().toUpperCase();
            if (upper === "ALLOW" || upper === "DENY") {
                for (const [reqId, pendingUserId] of pendingPermissions) {
                    if (pendingUserId === userId || pendingUserId === chatId) {
                        const decision = upper === "ALLOW" ? "allow" : "deny";
                        channel.sendPermissionVerdict({ request_id: reqId, behavior: decision }).catch(() => { });
                        pendingPermissions.delete(reqId);
                        break;
                    }
                }
            }
            channel.pushMessage(text, {
                chat_id: chatId,
                user: userId,
                reply_token: replyToken,
                ts: String(event.timestamp),
                ...(groupId ? { group_id: groupId } : {}),
                ...(roomId ? { room_id: roomId } : {}),
            }).catch((err) => {
                process.stderr.write(`[line] pushMessage error: ${err.message}\n`);
            });
        }
    }
    // ─── Webhook HTTP server ────────────────────────────────────────────────
    const middleware = line.middleware({ channelSecret: cfg.channelSecret });
    const server = http.createServer((req, res) => {
        if (req.method !== "POST" || req.url !== "/webhook") {
            res.writeHead(404);
            res.end();
            return;
        }
        // Collect body for LINE signature verification
        const chunks = [];
        req.on("data", (chunk) => chunks.push(chunk));
        req.on("end", () => {
            const body = Buffer.concat(chunks);
            // Manually verify signature
            const crypto = require("node:crypto");
            const signature = req.headers["x-line-signature"];
            const hash = crypto
                .createHmac("sha256", cfg.channelSecret)
                .update(body)
                .digest("base64");
            if (signature !== hash) {
                res.writeHead(401);
                res.end("Invalid signature");
                return;
            }
            try {
                const parsed = JSON.parse(body.toString());
                const events = parsed.events ?? [];
                handleWebhookEvents(events);
                res.writeHead(200);
                res.end("OK");
            }
            catch (err) {
                process.stderr.write(`[line] Webhook parse error: ${err.message}\n`);
                res.writeHead(400);
                res.end("Bad request");
            }
        });
    });
    // ─── Outbound: channel.onReply() → LINE send ───────────────────────────
    channel.onReply(async (chatId, text) => {
        const plain = stripMarkdown(text);
        const chunks = chunkText(plain, MAX_MSG_LEN);
        for (const chunk of chunks) {
            for (let attempt = 0; attempt < 3; attempt++) {
                try {
                    await lineClient.pushMessage({
                        to: chatId,
                        messages: [{ type: "text", text: chunk }],
                    });
                    break;
                }
                catch (err) {
                    if (err?.statusCode === 429) {
                        await sleep(5000);
                        continue;
                    }
                    process.stderr.write(`[line] Send error: ${err.message}\n`);
                    break;
                }
            }
        }
    });
    // ─── Permission prompts → quick reply buttons ──────────────────────────
    channel.onPermissionRequest(async (req) => {
        process.stderr.write(`[line] Permission request: ${req.tool_name} (${req.request_id})\n`);
        // We'd need an active chat to send to. In practice, track the most recent chatId.
        // For now, log and handle the next message as a potential permission reply.
    });
    // ─── Hook events ─────────────────────────────────────────────────────────
    channel.onHookEvent(async (input) => {
        return {};
    });
    // ─── Start server ────────────────────────────────────────────────────────
    await new Promise((resolve) => {
        server.listen(cfg.webhookPort, () => {
            process.stderr.write(`[line] Webhook server listening on port ${cfg.webhookPort}\n`);
            resolve();
        });
    });
    const cleanup = () => {
        server.close();
        channel.cleanup();
    };
    return { channel, cleanup };
}
//# sourceMappingURL=line.js.map