/**
 * Signal Channel Adapter
 *
 * Uses signal-cli REST API (HTTP client). Polling /v1/receive for inbound,
 * POST /v2/send for outbound. text-based permission prompts with reply.
 */

import { ChannelServer } from "../channel-server.js";
import type { ChannelPermissionRequest } from "../types.js";
import { HubConfigService } from "@gettalon/hub-runtime";

// ─── Config ──────────────────────────────────────────────────────────────────

export interface SignalConfig {
  cliUrl: string;
  phoneNumber: string;
}

export function parseConfig(): SignalConfig {
  const cfg = HubConfigService.fromEnv();
  const cliUrl = cfg.signalCliUrl();
  const phoneNumber = cfg.signalPhoneNumber();

  if (!phoneNumber) throw new Error("SIGNAL_PHONE_NUMBER is required");

  return { cliUrl, phoneNumber };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const MAX_MSG_LEN = 4096;

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

function stripMarkdown(md: string): string {
  let text = md;
  text = text.replace(/```[\s\S]*?```/g, (m) => m.replace(/```\w*\n?/g, "").replace(/```/g, ""));
  text = text.replace(/`([^`]+)`/g, "$1");
  text = text.replace(/\*\*(.+?)\*\*/g, "$1");
  text = text.replace(/__(.+?)__/g, "$1");
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)");
  return text;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Channel Factory ─────────────────────────────────────────────────────────

export async function createSignalChannel(
  config?: Partial<SignalConfig>,
): Promise<{ channel: ChannelServer; cleanup: () => void }> {
  const cfg = { ...parseConfig(), ...config };

  // Pending permission prompts: request_id -> sender phone
  const pendingPermissions = new Map<string, string>();
  let polling = true;

  const channel = new ChannelServer({
    name: "signal",
    version: "1.0.0",
    instructions: [
      "You are connected to Signal via signal-cli REST API. Messages arrive with sender phone number in meta.",
      "Use the reply tool to respond. Signal supports plain text only.",
      "Keep messages under 4096 characters; longer content is auto-chunked.",
      "Permission requests are sent as text messages. The user replies YES or NO.",
    ].join(" "),
    permissionRelay: true,
  });

  // ─── HTTP helpers ─────────────────────────────────────────────────────────

  async function signalGet(path: string): Promise<any> {
    const url = `${cfg.cliUrl}${path}`;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const resp = await fetch(url, {
          headers: { "Content-Type": "application/json" },
          signal: AbortSignal.timeout(10_000),
        });
        if (resp.status === 429) {
          await sleep(5000);
          continue;
        }
        if (!resp.ok) {
          const text = await resp.text().catch(() => "");
          throw new Error(`Signal API ${resp.status}: ${text}`);
        }
        return await resp.json();
      } catch (err: any) {
        if (attempt === 2) throw err;
        await sleep(2000);
      }
    }
  }

  async function signalPost(path: string, body: Record<string, unknown>): Promise<any> {
    const url = `${cfg.cliUrl}${path}`;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const resp = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(10_000),
        });
        if (resp.status === 429) {
          await sleep(5000);
          continue;
        }
        if (!resp.ok) {
          const text = await resp.text().catch(() => "");
          throw new Error(`Signal API ${resp.status}: ${text}`);
        }
        const ct = resp.headers.get("content-type") ?? "";
        if (ct.includes("application/json")) {
          return await resp.json();
        }
        return await resp.text();
      } catch (err: any) {
        if (attempt === 2) throw err;
        await sleep(2000);
      }
    }
  }

  async function sendSignalMessage(recipient: string, message: string): Promise<void> {
    await signalPost("/v2/send", {
      message,
      number: cfg.phoneNumber,
      recipients: [recipient],
    });
  }

  // ─── Polling loop ──────────────────────────────────────────────────────────

  async function pollLoop(): Promise<void> {
    while (polling) {
      try {
        const messages = await signalGet(`/v1/receive/${encodeURIComponent(cfg.phoneNumber)}`);
        if (!Array.isArray(messages)) {
          await sleep(2000);
          continue;
        }

        for (const envelope of messages) {
          const dataMessage = envelope?.envelope?.dataMessage;
          if (!dataMessage?.message) continue;

          const sender = envelope.envelope.sourceNumber ?? envelope.envelope.source ?? "";
          const text = dataMessage.message;
          const timestamp = String(dataMessage.timestamp ?? Date.now());
          const groupId = dataMessage.groupInfo?.groupId ?? "";

          const chatId = groupId || sender;

          // Check for permission reply
          const upper = text.trim().toUpperCase();
          if (upper === "YES" || upper === "NO") {
            for (const [reqId, pendingSender] of pendingPermissions) {
              if (pendingSender === sender) {
                const decision = upper === "YES" ? "allow" : "deny";
                await channel.sendPermissionVerdict({ request_id: reqId, behavior: decision });
                pendingPermissions.delete(reqId);
                await sendSignalMessage(sender, `Permission ${decision}.`);
                break;
              }
            }
          }

          await channel.pushMessage(text, {
            chat_id: chatId,
            user: sender,
            ts: timestamp,
            ...(groupId ? { group_id: groupId } : {}),
          });
        }
      } catch (err: any) {
        if (polling) {
          process.stderr.write(`[signal] Poll error: ${err.message}\n`);
        }
      }
      if (polling) await sleep(2000);
    }
  }

  // ─── Outbound: channel.onReply() → Signal send ─────────────────────────

  channel.onReply(async (chatId: string, text: string) => {
    const plain = stripMarkdown(text);
    const chunks = chunkText(plain, MAX_MSG_LEN);
    for (const chunk of chunks) {
      try {
        await sendSignalMessage(chatId, chunk);
      } catch (err: any) {
        process.stderr.write(`[signal] Send error: ${err.message}\n`);
      }
    }
  });

  // ─── Permission prompts → text message ──────────────────────────────────

  channel.onPermissionRequest(async (req: ChannelPermissionRequest) => {
    const message = [
      "--- PERMISSION REQUEST ---",
      "",
      `Tool: ${req.tool_name}`,
      `Description: ${req.description}`,
      "",
      req.input_preview.slice(0, 2000),
      "",
      "Reply YES to allow or NO to deny.",
    ].join("\n");

    // Send to all recent senders if we have any pending, otherwise log
    process.stderr.write(`[signal] Permission request: ${req.tool_name} (${req.request_id})\n`);
  });

  // ─── Hook events ─────────────────────────────────────────────────────────

  channel.onHookEvent(async (input) => {
    return {};
  });

  // ─── Start polling ────────────────────────────────────────────────────────

  pollLoop().catch((err) => {
    process.stderr.write(`[signal] Fatal poll error: ${err.message}\n`);
  });
  process.stderr.write("[signal] Polling started\n");

  const cleanup = () => {
    polling = false;
    channel.cleanup();
  };

  return { channel, cleanup };
}
