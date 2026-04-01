/**
 * iMessage Channel Adapter
 *
 * Uses AppleScript to send messages via Messages.app and polls
 * ~/Library/Messages/chat.db (SQLite) for incoming messages.
 *
 * Features:
 * - AppleScript bridge for sending via `osascript`
 * - SQLite polling of chat.db for new inbound messages
 * - Support for both phone numbers and email addresses as recipients
 * - Config: pollInterval, allowedContacts whitelist
 * - macOS platform check (throws clear error on non-macOS)
 * - Proper escaping for AppleScript strings
 * - Graceful fallback when SIP blocks chat.db access
 * - Extra tools: imessage_send, imessage_contacts, imessage_history
 */
import { ChannelServer } from "../channel-server.js";
import { HubConfigService } from "@gettalon/hub-runtime";
// ── Parse Config ──────────────────────────────────────────────────────────────
export function parseConfig() {
    const cfg = HubConfigService.fromEnv();
    const pollInterval = cfg.imessagePollInterval();
    const allowedContacts = cfg.imessageAllowedContacts();
    const chatDbPath = cfg.imessageChatDbPath();
    return {
        pollInterval,
        allowedContacts,
        chatDbPath,
    };
}
// ── Helpers ───────────────────────────────────────────────────────────────────
/** Escape a string for use inside AppleScript double-quoted strings */
function escapeAppleScript(text) {
    return text
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"')
        .replace(/\n/g, "\\n")
        .replace(/\r/g, "\\r")
        .replace(/\t/g, "\\t");
}
/**
 * Normalize a contact identifier.
 * Phone numbers: strip spaces/dashes, ensure +prefix.
 * Email addresses: lowercase trim.
 */
function normalizeContact(contact) {
    const trimmed = contact.trim();
    // If it looks like an email
    if (trimmed.includes("@")) {
        return trimmed.toLowerCase();
    }
    // Phone number: strip non-digit except leading +
    const digits = trimmed.replace(/[^+\d]/g, "");
    return digits;
}
// ── Extra MCP Tools ────────────────────────────────────────────────────────────
const EXTRA_TOOLS = [
    {
        name: "imessage_send",
        description: "Send an iMessage to a specific contact (phone number or email)",
        inputSchema: {
            type: "object",
            properties: {
                to: { type: "string", description: "Recipient phone number (e.g. +1234567890) or email" },
                text: { type: "string", description: "Message text to send" },
            },
            required: ["to", "text"],
        },
    },
    {
        name: "imessage_contacts",
        description: "List recent iMessage contacts from the chat database",
        inputSchema: {
            type: "object",
            properties: {
                limit: { type: "number", description: "Max contacts to return (default: 20)" },
            },
        },
    },
    {
        name: "imessage_history",
        description: "Get recent message history for a specific contact",
        inputSchema: {
            type: "object",
            properties: {
                contact: { type: "string", description: "Phone number or email to look up" },
                limit: { type: "number", description: "Max messages to return (default: 20)" },
            },
            required: ["contact"],
        },
    },
];
// ── Create Channel ────────────────────────────────────────────────────────────
export async function createIMessageChannel(config) {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const { existsSync } = await import("node:fs");
    const { homedir, platform } = await import("node:os");
    const execFileAsync = promisify(execFile);
    // ── macOS platform check ──────────────────────────────────────────────────
    if (platform() !== "darwin") {
        throw new Error("iMessage channel is only available on macOS. " +
            `Current platform: ${platform()}. ` +
            "Messages.app and the chat.db database are macOS-only.");
    }
    const cfg = { ...parseConfig(), ...config };
    const pollInterval = cfg.pollInterval ?? 5000;
    const allowedContacts = cfg.allowedContacts?.map(normalizeContact) ?? [];
    const chatDbPath = cfg.chatDbPath ?? `${homedir()}/Library/Messages/chat.db`;
    let shuttingDown = false;
    let pollTimer = null;
    let lastRowId = 0;
    let chatDbAvailable = false;
    // ── Check chat.db access ──────────────────────────────────────────────────
    async function checkChatDbAccess() {
        if (!existsSync(chatDbPath)) {
            process.stderr.write(`[imessage] chat.db not found at ${chatDbPath}\n`);
            return false;
        }
        try {
            // Test read access with a simple query
            await execFileAsync("sqlite3", [chatDbPath, "SELECT MAX(ROWID) FROM message LIMIT 1;"]);
            return true;
        }
        catch (err) {
            process.stderr.write(`[imessage] Cannot read chat.db (likely SIP/TCC restriction). ` +
                `Grant Full Disk Access to your terminal in System Settings > Privacy & Security. ` +
                `Error: ${err.message}\n`);
            return false;
        }
    }
    chatDbAvailable = await checkChatDbAccess();
    // ── Initialize last row ID ────────────────────────────────────────────────
    if (chatDbAvailable) {
        try {
            const { stdout } = await execFileAsync("sqlite3", [
                chatDbPath,
                "SELECT MAX(ROWID) FROM message;",
            ]);
            const maxId = parseInt(stdout.trim(), 10);
            if (!isNaN(maxId)) {
                lastRowId = maxId;
            }
            process.stderr.write(`[imessage] chat.db accessible — starting from message ROWID ${lastRowId}\n`);
        }
        catch {
            process.stderr.write(`[imessage] Failed to read max ROWID — will start from 0\n`);
        }
    }
    // ── Send message via AppleScript ──────────────────────────────────────────
    async function sendMessage(to, text) {
        const escapedText = escapeAppleScript(text);
        const escapedTo = escapeAppleScript(to);
        // Use the "buddy" form which works for both phone numbers and emails
        const script = `tell application "Messages"
  set targetService to 1st account whose service type = iMessage
  set targetBuddy to participant "${escapedTo}" of targetService
  send "${escapedText}" to targetBuddy
end tell`;
        try {
            await execFileAsync("osascript", ["-e", script]);
        }
        catch (err) {
            // Fallback: try the simpler "send to buddy" form
            const fallbackScript = `tell application "Messages"
  set targetBuddy to a reference to buddy "${escapedTo}" of (1st account whose service type = iMessage)
  send "${escapedText}" to targetBuddy
end tell`;
            try {
                await execFileAsync("osascript", ["-e", fallbackScript]);
            }
            catch (fallbackErr) {
                throw new Error(`Failed to send iMessage to ${to}: ${fallbackErr.message}. ` +
                    `Make sure Messages.app is running and the contact exists.`);
            }
        }
    }
    // ── Poll chat.db for new messages ──────────────────────────────────────────
    async function pollNewMessages() {
        if (!chatDbAvailable || shuttingDown)
            return;
        try {
            // Query for messages newer than our last seen ROWID
            // is_from_me = 0 means incoming messages
            const query = `
        SELECT
          m.ROWID,
          m.text,
          m.is_from_me,
          m.date,
          h.id as handle_id,
          h.service
        FROM message m
        LEFT JOIN handle h ON m.handle_id = h.ROWID
        WHERE m.ROWID > ${lastRowId}
          AND m.is_from_me = 0
          AND m.text IS NOT NULL
          AND m.text != ''
        ORDER BY m.ROWID ASC
        LIMIT 50;
      `;
            const { stdout } = await execFileAsync("sqlite3", [
                "-separator", "|",
                chatDbPath,
                query,
            ]);
            if (!stdout.trim())
                return;
            const lines = stdout.trim().split("\n");
            for (const line of lines) {
                const parts = line.split("|");
                if (parts.length < 5)
                    continue;
                const rowId = parseInt(parts[0], 10);
                const text = parts[1];
                const handleId = parts[4]; // phone number or email
                const service = parts[5] ?? "iMessage";
                if (isNaN(rowId) || !text || !handleId)
                    continue;
                // Update high-water mark
                if (rowId > lastRowId) {
                    lastRowId = rowId;
                }
                // Check allowlist
                const normalizedHandle = normalizeContact(handleId);
                if (allowedContacts.length > 0 && !allowedContacts.includes(normalizedHandle)) {
                    process.stderr.write(`[imessage] Ignoring message from unlisted contact: ${handleId}\n`);
                    continue;
                }
                // Push to Claude
                const chatId = `imessage:${normalizedHandle}`;
                process.stderr.write(`[imessage] New message from ${handleId}: ${text.slice(0, 80)}${text.length > 80 ? "..." : ""}\n`);
                await channel.pushMessage(`<channel source="imessage" chat_id="${chatId}" user="${handleId}" service="${service}">\n${text}\n</channel>`, { chat_id: chatId, user: handleId, service });
            }
        }
        catch (err) {
            if (!shuttingDown) {
                process.stderr.write(`[imessage] Poll error: ${err.message}\n`);
                // If we lost access to chat.db (e.g. SIP change), mark as unavailable
                if (err.message.includes("unable to open database") || err.message.includes("not authorized")) {
                    chatDbAvailable = false;
                    process.stderr.write(`[imessage] chat.db access lost — polling disabled\n`);
                }
            }
        }
    }
    // ── Query contacts from chat.db ──────────────────────────────────────────
    async function queryContacts(limit) {
        if (!chatDbAvailable) {
            return [];
        }
        try {
            const query = `
        SELECT
          h.id,
          h.service,
          MAX(m.date) as last_date
        FROM handle h
        JOIN message m ON m.handle_id = h.ROWID
        GROUP BY h.id
        ORDER BY last_date DESC
        LIMIT ${limit};
      `;
            const { stdout } = await execFileAsync("sqlite3", [
                "-separator", "|",
                chatDbPath,
                query,
            ]);
            if (!stdout.trim())
                return [];
            return stdout.trim().split("\n").map((line) => {
                const parts = line.split("|");
                return {
                    handle: parts[0] ?? "",
                    service: parts[1] ?? "",
                    lastMessage: parts[2] ?? "",
                };
            }).filter((c) => c.handle);
        }
        catch {
            return [];
        }
    }
    // ── Query message history from chat.db ──────────────────────────────────
    async function queryHistory(contact, limit) {
        if (!chatDbAvailable) {
            return [];
        }
        const normalized = normalizeContact(contact);
        try {
            const query = `
        SELECT
          m.text,
          m.is_from_me,
          datetime(m.date / 1000000000 + 978307200, 'unixepoch', 'localtime') as readable_date
        FROM message m
        JOIN handle h ON m.handle_id = h.ROWID
        WHERE h.id = '${normalized}'
          AND m.text IS NOT NULL
          AND m.text != ''
        ORDER BY m.date DESC
        LIMIT ${limit};
      `;
            const { stdout } = await execFileAsync("sqlite3", [
                "-separator", "|",
                chatDbPath,
                query,
            ]);
            if (!stdout.trim())
                return [];
            return stdout.trim().split("\n").map((line) => {
                const parts = line.split("|");
                return {
                    text: parts[0] ?? "",
                    isFromMe: parts[1] === "1",
                    date: parts[2] ?? "",
                };
            }).filter((m) => m.text);
        }
        catch {
            return [];
        }
    }
    // ── Channel Server ────────────────────────────────────────────────────────
    const instructions = [
        `Messages from iMessage arrive as <channel source="imessage" chat_id="imessage:<contact>" user="<phone_or_email>">`,
        `Reply with the reply tool, passing chat_id back.`,
        `Use imessage_send to send a message to any contact.`,
        `Use imessage_contacts to list recent contacts.`,
        `Use imessage_history to see message history with a contact.`,
        `The chat_id format is "imessage:<phone_or_email>".`,
    ];
    if (!chatDbAvailable) {
        instructions.push(`WARNING: chat.db is not accessible. Incoming message polling is disabled. ` +
            `You can still send messages. To enable receiving, grant Full Disk Access to the terminal.`);
    }
    const channel = new ChannelServer({
        name: "imessage",
        version: "1.0.0",
        instructions: instructions.join("\n"),
        extraTools: EXTRA_TOOLS,
    });
    // ── Reply handler ─────────────────────────────────────────────────────────
    channel.onReply(async (chatId, text) => {
        // chat_id format: "imessage:<contact>"
        const contact = chatId.replace(/^imessage:/, "");
        if (!contact) {
            process.stderr.write(`[imessage] Reply failed: no contact in chat_id "${chatId}"\n`);
            return;
        }
        try {
            await sendMessage(contact, text);
            process.stderr.write(`[imessage] Sent reply to ${contact}: ${text.slice(0, 80)}${text.length > 80 ? "..." : ""}\n`);
        }
        catch (err) {
            process.stderr.write(`[imessage] Reply error: ${err.message}\n`);
        }
    });
    // ── Tool handler ──────────────────────────────────────────────────────────
    channel.onToolCall(async (name, args) => {
        switch (name) {
            case "imessage_send": {
                const to = String(args.to ?? "");
                const text = String(args.text ?? "");
                if (!to || !text)
                    throw new Error("Both 'to' and 'text' are required");
                await sendMessage(to, text);
                return `Message sent to ${to}`;
            }
            case "imessage_contacts": {
                const limit = typeof args.limit === "number" ? args.limit : 20;
                const contacts = await queryContacts(limit);
                if (contacts.length === 0) {
                    return chatDbAvailable
                        ? "No contacts found in message history."
                        : "chat.db is not accessible. Grant Full Disk Access to the terminal.";
                }
                return contacts.map((c) => `${c.handle} (${c.service})`).join("\n");
            }
            case "imessage_history": {
                const contact = String(args.contact ?? "");
                const limit = typeof args.limit === "number" ? args.limit : 20;
                if (!contact)
                    throw new Error("'contact' is required");
                const history = await queryHistory(contact, limit);
                if (history.length === 0) {
                    return chatDbAvailable
                        ? `No messages found for ${contact}.`
                        : "chat.db is not accessible. Grant Full Disk Access to the terminal.";
                }
                return history
                    .reverse()
                    .map((m) => `[${m.date}] ${m.isFromMe ? "Me" : contact}: ${m.text}`)
                    .join("\n");
            }
            default:
                throw new Error(`Unknown tool: ${name}`);
        }
    });
    // ── Start polling ─────────────────────────────────────────────────────────
    if (chatDbAvailable) {
        pollTimer = setInterval(pollNewMessages, pollInterval);
        process.stderr.write(`[imessage] Polling chat.db every ${pollInterval}ms\n`);
    }
    process.stderr.write(`[imessage] Channel ready\n`);
    process.stderr.write(`[imessage] chat.db: ${chatDbAvailable ? "accessible" : "NOT accessible (send only)"}\n`);
    if (allowedContacts.length > 0) {
        process.stderr.write(`[imessage] Allowed contacts: ${allowedContacts.join(", ")}\n`);
    }
    else {
        process.stderr.write(`[imessage] Allowed contacts: all (no whitelist)\n`);
    }
    // ── Cleanup ────────────────────────────────────────────────────────────────
    const cleanup = () => {
        if (shuttingDown)
            return;
        shuttingDown = true;
        if (pollTimer) {
            clearInterval(pollTimer);
            pollTimer = null;
        }
        channel.cleanup();
    };
    return { channel, cleanup };
}
//# sourceMappingURL=imessage.js.map