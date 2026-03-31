/**
 * Discord Channel Adapter
 *
 * Uses discord.js Client. Message events for inbound, markdown support (2000 char limit),
 * button components for permission prompts, extra tools: discord_react, discord_thread, discord_edit.
 */
// NOTE: This legacy channel adapter reads process.env directly.
// Sanctioned exception: migration to HubConfigService is deferred until
// the adapter is brought into the active monorepo architecture.
// See REMAINING_FIXES.md §1 for context.
import { ChannelServer } from "../channel-server.js";
export function parseConfig() {
    const token = process.env.DISCORD_TOKEN ?? "";
    if (!token)
        throw new Error("DISCORD_TOKEN is required");
    const allowedChannels = process.env.DISCORD_ALLOWED_CHANNELS
        ?.split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    return { token, allowedChannels };
}
// ─── Helpers ─────────────────────────────────────────────────────────────────
const MAX_MSG_LEN = 2000;
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
async function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
// ─── Extra Tools ─────────────────────────────────────────────────────────────
const EXTRA_TOOLS = [
    {
        name: "discord_react",
        description: "Add an emoji reaction to a Discord message",
        inputSchema: {
            type: "object",
            properties: {
                channel_id: { type: "string", description: "Discord channel ID" },
                message_id: { type: "string", description: "Message ID to react to" },
                emoji: { type: "string", description: "Emoji or custom emoji name" },
            },
            required: ["channel_id", "message_id", "emoji"],
        },
    },
    {
        name: "discord_thread",
        description: "Create a new thread from a message or in a channel",
        inputSchema: {
            type: "object",
            properties: {
                channel_id: { type: "string", description: "Channel ID" },
                name: { type: "string", description: "Thread name" },
                message_id: { type: "string", description: "Message ID to start thread from (optional)" },
                auto_archive_duration: { type: "number", description: "Minutes: 60, 1440, 4320, or 10080" },
            },
            required: ["channel_id", "name"],
        },
    },
    {
        name: "discord_edit",
        description: "Edit a previously sent Discord message (bot's own messages only)",
        inputSchema: {
            type: "object",
            properties: {
                channel_id: { type: "string", description: "Channel ID" },
                message_id: { type: "string", description: "Message ID to edit" },
                text: { type: "string", description: "New message content" },
            },
            required: ["channel_id", "message_id", "text"],
        },
    },
];
// ─── Channel Factory ─────────────────────────────────────────────────────────
export async function createDiscordChannel(config) {
    // @ts-ignore - discord.js is an optional peer dependency
    const _discord = await import("discord.js");
    const { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, ChannelType } = _discord;
    const cfg = { ...parseConfig(), ...config };
    if (!cfg.token)
        throw new Error("DISCORD_TOKEN is required");
    const client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent,
            GatewayIntentBits.GuildMessageReactions,
            GatewayIntentBits.DirectMessages,
        ],
    });
    const allowedSet = cfg.allowedChannels ? new Set(cfg.allowedChannels) : null;
    const pendingPermissions = new Map(); // request_id -> channelId
    const channel = new ChannelServer({
        name: "discord",
        version: "1.0.0",
        instructions: [
            "You are connected to Discord. Messages arrive with channel_id and message_id in meta.",
            "Use the reply tool to respond. For advanced features use discord_react, discord_thread, discord_edit.",
            "Discord supports markdown natively. Keep messages under 2000 characters; longer content is auto-chunked.",
            "Permission requests appear as button components. The user clicks Allow or Deny.",
        ].join(" "),
        permissionRelay: true,
        extraTools: EXTRA_TOOLS,
    });
    // ─── Inbound: Discord messages → channel.pushMessage() ──────────────────
    client.on("messageCreate", async (msg) => {
        if (msg.author.bot)
            return;
        if (allowedSet && !allowedSet.has(msg.channelId))
            return;
        const user = msg.author.tag ?? msg.author.username ?? "unknown";
        await channel.pushMessage(msg.content, {
            chat_id: msg.channelId,
            message_id: msg.id,
            user,
            guild_id: msg.guildId ?? "",
            ts: String(msg.createdTimestamp),
        });
    });
    // ─── Outbound: channel.onReply() → Discord send ─────────────────────────
    channel.onReply(async (chatId, text) => {
        const ch = await client.channels.fetch(chatId);
        if (!ch || !("send" in ch))
            return;
        const chunks = chunkText(text, MAX_MSG_LEN);
        for (const chunk of chunks) {
            for (let attempt = 0; attempt < 3; attempt++) {
                try {
                    await ch.send(chunk);
                    break;
                }
                catch (err) {
                    if (err?.status === 429) {
                        const retryAfter = err.retryAfter ?? 5;
                        await sleep(retryAfter * 1000);
                        continue;
                    }
                    process.stderr.write(`[discord] Send error: ${err.message}\n`);
                    break;
                }
            }
        }
    });
    // ─── Permission prompts → button components ─────────────────────────────
    channel.onPermissionRequest(async (req) => {
        const targets = allowedSet ? [...allowedSet] : [];
        if (targets.length === 0) {
            process.stderr.write("[discord] No target channels for permission prompt\n");
            return;
        }
        const row = new ActionRowBuilder().addComponents(new ButtonBuilder()
            .setCustomId(`perm:${req.request_id}:allow`)
            .setLabel("Allow")
            .setStyle(ButtonStyle.Success), new ButtonBuilder()
            .setCustomId(`perm:${req.request_id}:deny`)
            .setLabel("Deny")
            .setStyle(ButtonStyle.Danger));
        const content = [
            "**Permission Request**",
            "",
            `**Tool:** \`${req.tool_name}\``,
            `**Description:** ${req.description}`,
            "",
            `\`\`\`\n${req.input_preview.slice(0, 1500)}\n\`\`\``,
        ].join("\n");
        for (const channelId of targets) {
            try {
                const ch = await client.channels.fetch(channelId);
                if (!ch || !("send" in ch))
                    continue;
                const sent = await ch.send({ content, components: [row] });
                pendingPermissions.set(req.request_id, channelId);
                // Collect button interaction
                const collector = sent.createMessageComponentCollector({
                    componentType: ComponentType.Button,
                    time: 300_000, // 5 min timeout
                    max: 1,
                });
                collector.on("collect", async (interaction) => {
                    const customId = interaction.customId;
                    const [, requestId, decision] = customId.split(":");
                    if (requestId && (decision === "allow" || decision === "deny")) {
                        await channel.sendPermissionVerdict({ request_id: requestId, behavior: decision });
                        pendingPermissions.delete(requestId);
                        await interaction.update({
                            content: `${content}\n\n**${decision === "allow" ? "Allowed" : "Denied"}** by ${interaction.user.tag}`,
                            components: [],
                        });
                    }
                });
                collector.on("end", async (collected) => {
                    if (collected.size === 0) {
                        // Timed out — auto deny
                        await channel.sendPermissionVerdict({ request_id: req.request_id, behavior: "deny" });
                        pendingPermissions.delete(req.request_id);
                        try {
                            await sent.edit({ content: `${content}\n\n**Timed out — auto denied**`, components: [] });
                        }
                        catch { }
                    }
                });
            }
            catch (err) {
                process.stderr.write(`[discord] Permission prompt error: ${err.message}\n`);
            }
        }
    });
    // ─── Extra tool handlers ─────────────────────────────────────────────────
    channel.onToolCall(async (name, args) => {
        switch (name) {
            case "discord_react": {
                const channelId = args.channel_id;
                const messageId = args.message_id;
                const emoji = args.emoji;
                const ch = await client.channels.fetch(channelId);
                if (!ch || !("messages" in ch))
                    throw new Error("Channel not found or not text-based");
                const msg = await ch.messages.fetch(messageId);
                await msg.react(emoji);
                return { ok: true };
            }
            case "discord_thread": {
                const channelId = args.channel_id;
                const threadName = args.name;
                const messageId = args.message_id;
                const autoArchiveDuration = args.auto_archive_duration ?? 1440;
                const ch = await client.channels.fetch(channelId);
                if (!ch || !("threads" in ch))
                    throw new Error("Channel not found or not a text channel");
                if (messageId) {
                    const msg = await ch.messages.fetch(messageId);
                    const thread = await msg.startThread({ name: threadName, autoArchiveDuration });
                    return { ok: true, thread_id: thread.id };
                }
                else {
                    const thread = await ch.threads.create({
                        name: threadName,
                        autoArchiveDuration,
                        type: ChannelType.PublicThread,
                    });
                    return { ok: true, thread_id: thread.id };
                }
            }
            case "discord_edit": {
                const channelId = args.channel_id;
                const messageId = args.message_id;
                const text = args.text;
                const ch = await client.channels.fetch(channelId);
                if (!ch || !("messages" in ch))
                    throw new Error("Channel not found");
                const msg = await ch.messages.fetch(messageId);
                await msg.edit(text);
                return { ok: true };
            }
            default:
                throw new Error(`Unknown tool: ${name}`);
        }
    });
    // ─── Hook events ─────────────────────────────────────────────────────────
    channel.onHookEvent(async (input) => {
        if (input.hook_event_name === "Notification" && "message" in input) {
            const targets = allowedSet ? [...allowedSet] : [];
            for (const channelId of targets) {
                try {
                    const ch = await client.channels.fetch(channelId);
                    if (ch && "send" in ch) {
                        await ch.send(`**[Notification]** ${input.message}`);
                    }
                }
                catch { }
            }
        }
        return {};
    });
    // ─── Start client ────────────────────────────────────────────────────────
    await client.login(cfg.token);
    process.stderr.write("[discord] Client logged in\n");
    const cleanup = () => {
        client.destroy();
        channel.cleanup();
    };
    return { channel, cleanup };
}
//# sourceMappingURL=discord.js.map