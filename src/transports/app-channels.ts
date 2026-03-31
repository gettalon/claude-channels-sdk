/**
 * Application-Level Channel Adapters as Transport Wrappers
 *
 * Wraps each application-level channel adapter (Discord, Slack, WhatsApp, etc.)
 * as a TransportAdapter so the edge agent can use them via:
 *   connect discord://<channel_id>
 *   connect slack://<channel_id>
 *   connect whatsapp://<jid>
 *   etc.
 *
 * Each wrapper:
 * - Uses the channel's ChannelServer for receiving messages (pushMessage -> onMessage)
 * - Sends messages via the channel's reply mechanism (send -> onReply)
 * - Registers as a channel type in the transport registry
 */

import type {
  Transport,
  TransportAdapter,
  ConnectionHandler,
  MessageHandler,
  ProtocolMessage,
} from "../protocol.js";
import type { ChannelServer } from "../channel-server.js";

// ── Generic Transport wrapping a ChannelServer ──────────────────────────────

/**
 * A Transport that bridges ChannelServer bidirectional messaging
 * to the edge agent protocol.
 */
class AppChannelTransport implements Transport {
  readonly type: string;
  private _connected = true;
  private onMessage?: MessageHandler;

  constructor(
    type: string,
    private channelServer: ChannelServer,
    private chatId: string,
    onMessage?: MessageHandler,
  ) {
    this.type = type;
    this.onMessage = onMessage;
  }

  get connected() {
    return this._connected;
  }

  /** Feed a raw protocol message into this transport (from ChannelServer) */
  handleIncoming(msg: ProtocolMessage): void {
    this.onMessage?.(msg);
  }

  /** Send a protocol message out through the ChannelServer */
  async send(message: ProtocolMessage): Promise<void> {
    if (!this._connected) throw new Error("Not connected");
    const msg = message as any;

    // Silent protocol messages — don't relay to the chat platform
    const silentTypes = [
      "heartbeat",
      "heartbeat_ack",
      "ack",
      "register",
      "register_ack",
    ];
    if (silentTypes.includes(msg.type)) return;

    // Chat/reply messages: push text through the ChannelServer's reply path
    if (msg.type === "chat" || msg.type === "reply") {
      const text = msg.content ?? msg.text ?? "";
      const from = msg.from ? `[${msg.from}] ` : "";
      // Emit as a reply through the ChannelServer (triggers onReply handlers)
      this.channelServer.emit("reply", this.chatId, `${from}${text}`);
      return;
    }

    // Other protocol messages: serialize as JSON and send as text
    this.channelServer.emit("reply", this.chatId, JSON.stringify(message));
  }

  async close(): Promise<void> {
    this._connected = false;
  }
}

// ── Generic Adapter wrapping a channel factory ──────────────────────────────

interface ChannelSetup {
  channel: ChannelServer;
  cleanup: () => void;
}

type ChannelFactory = (config?: Record<string, unknown>) => Promise<ChannelSetup>;

/**
 * Generic TransportAdapter that wraps any application-level channel.
 *
 * - listen(): starts the channel, routes incoming messages to new transports
 * - connect(): starts the channel, creates a transport bound to a specific chat
 * - close(): cleans up the channel
 */
class AppChannelAdapter implements TransportAdapter {
  readonly type: string;
  private setup: ChannelSetup | null = null;
  private transports = new Map<string, AppChannelTransport>();
  private connectionHandler: ConnectionHandler | null = null;

  constructor(
    type: string,
    private factory: ChannelFactory,
    private config: Record<string, unknown>,
  ) {
    this.type = type;
  }

  private async ensureChannel(): Promise<ChannelSetup> {
    if (!this.setup) {
      this.setup = await this.factory(this.config);

      // Wire up the ChannelServer's pushMessage notifications.
      // When the channel receives an inbound message, the ChannelServer emits
      // a "hookEvent" or pushes a notification. We listen for the internal
      // message events to route them to the appropriate transport.
      const cs = this.setup.channel;

      // The ChannelServer's onReply is used for outbound. For inbound, the
      // channel adapters call cs.pushMessage(content, meta) which sends MCP
      // notifications. We intercept by listening to the 'reply' event that
      // our AppChannelTransport emits through the ChannelServer.
      // But for receiving messages FROM the platform INTO the transport, we
      // need to hook into the channel's message flow.

      // Override pushMessage to also route to our transports
      const originalPushMessage = cs.pushMessage.bind(cs);
      cs.pushMessage = async (
        content: string,
        meta?: Record<string, string>,
        sessionId?: string,
      ): Promise<void> => {
        // Still push to MCP sessions
        await originalPushMessage(content, meta, sessionId);

        // Also route to our edge agent transports
        const chatId = meta?.chat_id ?? "default";
        const from = meta?.user ?? "unknown";

        const protocolMsg: ProtocolMessage = {
          type: "chat",
          chat_id: chatId,
          content,
          from,
          meta,
        } as any;

        // Route to existing transport or create new one (server mode)
        let transport = this.transports.get(chatId);
        if (!transport && this.connectionHandler) {
          // Server mode: new chat -> new transport
          transport = new AppChannelTransport(this.type, cs, chatId);
          this.transports.set(chatId, transport);
          this.connectionHandler(transport);
        }
        if (transport) {
          transport.handleIncoming(protocolMsg);
        }
      };

      // Wire the reply event so AppChannelTransport.send() triggers the
      // channel's registered onReply handler
      // (The channel adapters already call channel.onReply() to set up
      //  their outbound path, so we just need the event to flow through.)
    }
    return this.setup;
  }

  /** Server mode: start channel, route incoming messages to transports */
  async listen(_port: number, handler: ConnectionHandler): Promise<void> {
    this.connectionHandler = handler;
    await this.ensureChannel();
  }

  /** Client mode: connect to a specific chat via the channel */
  async connect(url: string, handler: MessageHandler): Promise<Transport> {
    const setup = await this.ensureChannel();

    // Parse URL: "discord://<chat_id>" or just "<chat_id>"
    const prefix = `${this.type}://`;
    const chatId = url.startsWith(prefix) ? url.slice(prefix.length) : url;

    const transport = new AppChannelTransport(
      this.type,
      setup.channel,
      chatId,
      handler,
    );
    this.transports.set(chatId, transport);
    return transport;
  }

  async close(): Promise<void> {
    for (const t of this.transports.values()) {
      await t.close().catch(() => {});
    }
    this.transports.clear();
    if (this.setup) {
      this.setup.cleanup();
      this.setup = null;
    }
  }
}

// ── Channel-specific adapter factories ──────────────────────────────────────

export function createDiscordTransport(
  config: Record<string, unknown> = {},
): TransportAdapter {
  return new AppChannelAdapter(
    "discord",
    async (cfg) => {
      const { createDiscordChannel } = await import("../channels/discord.js");
      return createDiscordChannel(cfg as any);
    },
    config,
  );
}

export function createSlackTransport(
  config: Record<string, unknown> = {},
): TransportAdapter {
  return new AppChannelAdapter(
    "slack",
    async (cfg) => {
      const { createSlackChannel } = await import("../channels/slack.js");
      return createSlackChannel(cfg as any);
    },
    config,
  );
}

export function createWhatsAppTransport(
  config: Record<string, unknown> = {},
): TransportAdapter {
  return new AppChannelAdapter(
    "whatsapp",
    async (cfg) => {
      const { createWhatsAppChannel } = await import(
        "../channels/whatsapp.js"
      );
      return createWhatsAppChannel(cfg as any);
    },
    config,
  );
}

export function createMatrixTransport(
  config: Record<string, unknown> = {},
): TransportAdapter {
  return new AppChannelAdapter(
    "matrix",
    async (cfg) => {
      const { createMatrixChannel } = await import("../channels/matrix.js");
      return createMatrixChannel(cfg as any);
    },
    config,
  );
}

export function createSignalTransport(
  config: Record<string, unknown> = {},
): TransportAdapter {
  return new AppChannelAdapter(
    "signal",
    async (cfg) => {
      const { createSignalChannel } = await import("../channels/signal.js");
      return createSignalChannel(cfg as any);
    },
    config,
  );
}

export function createIrcTransport(
  config: Record<string, unknown> = {},
): TransportAdapter {
  return new AppChannelAdapter(
    "irc",
    async (cfg) => {
      const { createIrcChannel } = await import("../channels/irc.js");
      return createIrcChannel(cfg as any);
    },
    config,
  );
}

export function createLineTransport(
  config: Record<string, unknown> = {},
): TransportAdapter {
  return new AppChannelAdapter(
    "line",
    async (cfg) => {
      const { createLineChannel } = await import("../channels/line.js");
      return createLineChannel(cfg as any);
    },
    config,
  );
}

export function createFeishuTransport(
  config: Record<string, unknown> = {},
): TransportAdapter {
  return new AppChannelAdapter(
    "feishu",
    async (cfg) => {
      const { createFeishuChannel } = await import("../channels/feishu.js");
      return createFeishuChannel(cfg as any);
    },
    config,
  );
}

export function createMsTeamsTransport(
  config: Record<string, unknown> = {},
): TransportAdapter {
  return new AppChannelAdapter(
    "msteams",
    async (cfg) => {
      const { createTeamsChannel } = await import("../channels/msteams.js");
      return createTeamsChannel(cfg as any);
    },
    config,
  );
}

export function createIMessageTransport(
  config: Record<string, unknown> = {},
): TransportAdapter {
  return new AppChannelAdapter(
    "imessage",
    async (cfg) => {
      const { createIMessageChannel } = await import("../channels/imessage.js");
      return createIMessageChannel(cfg as any);
    },
    config,
  );
}
