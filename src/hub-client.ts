/**
 * hub-client.ts — Client connection and transport selection for ChannelHub.
 * Extracted from hub.ts (lines 1181–1289).
 */
import type { ChannelHub } from "./hub.js";
// randomAgentName is imported at runtime; circular dep is safe because
// installClient() runs after hub.ts fully evaluates.
import { randomAgentName, ensureMachineId } from "./hub.js";
import { transportRequiresE2E } from "./protocol.js";

/** Install client connection methods onto the ChannelHub prototype. */
export function installClient(Hub: typeof ChannelHub): void {

  Hub.prototype.connect = async function(this: ChannelHub, url: string, agentName?: string, connectionConfig?: Record<string, unknown>): Promise<void> {
    await ensureMachineId();
    const name = agentName ?? (this as any).opts.agentName ?? process.env.TALON_AGENT_NAME ?? (this as any).name ?? randomAgentName();
    // Also check if a resolved form of this URL is already connected
    // (prevents auto://, ws://localhost, unix:// duplicates to the same hub)
    const port = (this as any).extractPort?.(url);
    const findExisting = () => {
      if (this.clients.has(url)) return this.clients.get(url);
      if (port) {
        const aliases = [`auto://localhost:${port}`, `ws://localhost:${port}`, `unix:///tmp/talon-${port}.sock`];
        for (const alias of aliases) {
          if (alias !== url && this.clients.has(alias)) return this.clients.get(alias);
        }
      }
      return undefined;
    };
    const existing = findExisting();
    if (existing) {
      // Already connected — resend register to get a fresh register_ack with updated discovery info
      try { existing.ws.send(JSON.stringify({ type: "register", agent_name: name, tools: (this as any).clientTools })); } catch {}
      return;
    }

    let transportType = this.detectTransport(url);
    const preferLocal = (this as any).opts.preferLocalIpc !== false; // default true

    // ── Auto-transport selection ──────────────────────────────────────
    // auto:// scheme: let SDK pick the best transport
    // ws://localhost or ws://127.0.0.1: try unix socket first when preferLocalIpc is true
    const isAuto = transportType === "auto";
    const isLocalWs = transportType === "websocket" && (this as any).isLocalUrl(url);
    const shouldTryUnix = (isAuto || isLocalWs) && preferLocal;

    let resolvedUrl = isAuto ? (this as any).autoToWsUrl(url) : url;
    let actualTransport = transportType === "auto" ? "websocket" : transportType;

    if (shouldTryUnix) {
      const port = (this as any).extractPort(url);
      if (port) {
        const socketPath = `/tmp/talon-${port}.sock`;
        const unixUrl = `unix://${socketPath}`;
        try {
          // Attempt unix socket connection
          await import("./transports/index.js");
          const { createChannel: createCh } = await import("./protocol.js");
          const unixAdapter = createCh("unix", {});
          const testTransport = await unixAdapter.connect(unixUrl, () => {});
          // Success — use unix socket
          await testTransport.close();
          resolvedUrl = unixUrl;
          actualTransport = "unix";
          process.stderr.write(`[${this.name}] Auto-selected unix socket for local connection\n`);
        } catch {
          // Unix socket not available — fall back to WS
          actualTransport = "websocket";
          process.stderr.write(`[${this.name}] Unix socket unavailable, falling back to WebSocket\n`);
        }
      }
    }

    await import("./transports/index.js");
    const { createChannel } = await import("./protocol.js");
    const settings = await this.loadSettings();
    // Per-connection config: connectionConfig > connections[].config > transports[type]
    // transports[type] may be a single object (legacy) or an array (new many-to-many style)
    const rawTransportCfg = settings.transports?.[actualTransport];
    let transportConfig: Record<string, unknown> = Array.isArray(rawTransportCfg)
      ? { ...(rawTransportCfg[0] ?? {}) }  // use first entry as defaults
      : { ...(rawTransportCfg ?? {}) };
    // Check if this URL has specific config in the connections array
    const savedConn = (settings.connections ?? []).find((c: any) => c.url === url || c.url === resolvedUrl);
    if (savedConn?.config) {
      transportConfig = { ...transportConfig, ...savedConn.config };
    }
    // Explicit connectionConfig overrides everything
    if (connectionConfig) {
      transportConfig = { ...transportConfig, ...connectionConfig };
    }
    if (actualTransport === "telegram" && !(transportConfig as any).botToken) {
      (transportConfig as any).botToken = process.env.TELEGRAM_BOT_TOKEN;
    }

    const adapter = createChannel(actualTransport, transportConfig as Record<string, unknown>);
    const transport = await adapter.connect(resolvedUrl, (msg: any) => {
      // ── E2E decryption: unwrap encrypted messages ──
      if (msg.type === "e2e" && msg.e2e) {
        // Find session by server name (the hub we're connected to)
        const session = [...this.e2eSessions.values()][0]; // client has at most one server session
        if (session) {
          try {
            const decrypted = session.decrypt(msg.e2e);
            msg = typeof decrypted === "string" ? JSON.parse(decrypted) : decrypted;
          } catch (e: any) {
            process.stderr.write(`[${this.name}] E2E decrypt failed: ${e.message}\n`);
            return;
          }
        } else {
          process.stderr.write(`[${this.name}] Received e2e message but no session\n`);
          return;
        }
      }
      // ── Key exchange: hub sends its public key ──
      if (msg.type === "key_exchange" && msg.publicKey) {
        (async () => {
          try {
            const { E2eSession, loadOrCreateIdentity } = await import("./mesh.js");
            const { getTalonHome } = await import("./hub-settings.js");
            if (!(this as any)._identity) (this as any)._identity = await loadOrCreateIdentity(getTalonHome());
            const identity = (this as any)._identity;
            const hubName = name ?? "hub";
            this.peerKeys.set(hubName, msg.publicKey);
            this.e2eSessions.set(hubName, E2eSession.fromKeyExchange(identity.privateKey, msg.publicKey, this.name));
            process.stderr.write(`[${this.name}] E2E session established with hub\n`);
          } catch (e: any) {
            process.stderr.write(`[${this.name}] Key exchange failed: ${e.message}\n`);
          }
        })();
        return;
      }
      if (msg.type === "ack") return;

      // ── Pairing flow: handle register_ack status from server ──
      if (msg.type === "register_ack") {
        if (msg.status === "pending_approval") {
          process.stderr.write(`[${this.name}] Approval required by server. Pairing code: ${msg.message ?? "unknown"}\n`);
          this.emit("approvalPending", { message: msg.message, url: resolvedUrl, transport: actualTransport });
          this.emit("message", {
            content: `Pending approval from server. ${msg.message ?? ""}`,
            chatId: "system", user: "system", type: "system", source: this.name,
          });
        } else if (msg.status === "denied") {
          process.stderr.write(`[${this.name}] Connection denied by server: ${msg.message ?? ""}\n`);
          this.emit("approvalDenied", { message: msg.message, url: resolvedUrl });
          this.emit("message", {
            content: `Connection denied by server. ${msg.message ?? ""}`,
            chatId: "system", user: "system", type: "system", source: this.name,
          });
        } else if (msg.status === "ok") {
          // Approved (either immediately or after pending)
          process.stderr.write(`[${this.name}] Registered with server as agent "${msg.agent_id ?? name}"\n`);
          this.emit("approvalGranted", { agentId: msg.agent_id, url: resolvedUrl, info: msg.info });
          // "Approved" is already captured in the "connected" event → "Ready" summary; suppress here.
          // Cache remote discovery info in settings.json
          if (msg.info) {
            (async () => {
              try {
                const settings = await this.loadSettings();
                const conn = (settings.connections ?? []).find((c: any) => c.url === storeUrl || c.url === url);
                if (conn) {
                  conn.remoteInfo = { ...msg.info, cachedAt: new Date().toISOString() };
                  await this.saveSettings(settings);
                  const agentCount = msg.info.agents?.length ?? 0;
                  const groupCount = msg.info.groups?.length ?? 0;
                  process.stderr.write(`[${this.name}] Cached remote info: ${agentCount} agent(s), ${groupCount} group(s)\n`);
                }
              } catch (e: any) {
                process.stderr.write(`[${this.name}] Failed to cache remote info: ${e.message}\n`);
              }
            })();
          }
        }
        return;
      }

      if (msg.type === "tool_call") (this as any).handleClientToolCall(msg, transport);
      if (msg.type === "tool_result") {
        // Resolve a pending proxied tool call
        const p = this.pendingCalls.get(msg.call_id);
        if (p) { clearTimeout(p.timer); this.pendingCalls.delete(msg.call_id); p.resolve(msg.error ? { error: msg.error } : msg.result); }
      }
      if (msg.type === "proxy_result") {
        // Resolve a pending proxy command from proxyToServer()
        const p = (this as any).pendingProxyCalls.get(msg.proxy_id);
        if (p) {
          clearTimeout(p.timer);
          (this as any).pendingProxyCalls.delete(msg.proxy_id);
          if (msg.error) p.reject(new Error(msg.error));
          else p.resolve(msg.result);
        }
      }
      if (msg.type === "chat" || msg.type === "reply") {
        const rawChatId = msg.chat_id ?? "host";
        const files = msg.files as any[] | undefined;
        const client = this.clients.get(storeUrl);

        // Register user as an addressable target scoped to this connection (many-to-many safe).
        // UUID conversion only applies to channel-role connections (telegram, slack, etc.)
        // where the same raw chat_id may appear across multiple bots.
        // Server-role connections (hub-to-hub) keep their raw chat_id.
        let chatId = rawChatId;
        const isChannelConn = client?.role === "channel";
        if (rawChatId !== "host" && isChannelConn && (this as any).registerTarget && client) {
          const user = msg.from ?? rawChatId;
          const uuid = (this as any).registerTarget(user, actualTransport, rawChatId, "user", storeUrl);
          chatId = uuid;  // MCP layer always sees UUID as chat_id
          // Key channelForChat by UUID for precise multi-bot routing
          if (!this.channelForChat.has(uuid)) {
            this.channelForChat.set(uuid, client);
          }
        } else if (rawChatId !== "host" && client && !this.channelForChat.has(rawChatId)) {
          // Server-role (hub-to-hub): keep raw chatId so reply() can route back
          this.channelForChat.set(rawChatId, client);
        }

        // Client receives chat from server — emit directly, don't re-route through server
        this.emit("message", { content: msg.content ?? msg.text, chatId, user: msg.from ?? "host", type: "chat", source: resolvedUrl, ...(files?.length ? { files } : {}), ...(chatId !== rawChatId ? { raw_chat_id: rawChatId } : {}) });
        this.fireHooks("onMessage", { content: msg.content ?? msg.text, chatId, user: msg.from ?? "host", type: "chat" }).catch(() => {});
      }
      if (msg.type === "group_broadcast") {
        this.emit("message", { content: msg.content, chatId: msg.meta?.group ?? "group", user: msg.from ?? "unknown", type: "chat" });
        this.fireHooks("onMessage", { content: msg.content, chatId: msg.meta?.group ?? "group", user: msg.from ?? "unknown", type: "chat" }).catch(() => {});
      }
      if (msg.type === "stream_start" || msg.type === "stream_chunk" || msg.type === "stream_end") {
        this.emit("stream", msg);
      }
    });

    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
    const clearHeartbeat = () => {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = undefined;
      }
    };
    const ws = {
      send: (data: string) => transport.send(JSON.parse(data)),
      get readyState() {
        return transport.connected ? 1 : 3;
      },
      close: () => {
        clearHeartbeat();
        // Close both the transport AND the adapter (stops polling loops)
        adapter.close().catch(() => {});
        return transport.close();
      },
    } as any;
    const clientId = crypto.randomUUID();
    // Store under resolved URL (not original) to prevent duplicate connections
    // e.g. auto://localhost:9090 resolves to unix:///tmp/talon-9090.sock
    const storeUrl = resolvedUrl;
    const channelId = `${actualTransport}:${storeUrl.replace(/^[a-z]+:\/\//, "")}`;
    // Determine role: WS/Unix to a server = "server", everything else = "channel"
    const isServerConn = (actualTransport === "websocket" || actualTransport === "unix") && !storeUrl.startsWith("telegram://");
    this.clients.set(storeUrl, {
      id: clientId,
      url: storeUrl,
      channelId,
      transport: actualTransport,
      role: isServerConn ? "server" : "channel",
      ws,
      name,
      heartbeatTimer,
    } as any);
    // Prefer the user-configured name; fall back to adapter's display name (e.g. @BotUsername for Telegram)
    // Then resolve alias from settings.json { aliases: { "@BotName": "arc" } }
    const rawDisplayName = name ?? (adapter as any).displayName;
    const aliases = (settings as any).aliases as Record<string, string> | undefined;
    const displayName = aliases?.[rawDisplayName] ?? rawDisplayName;
    const storedClient = this.clients.get(storeUrl);
    if (storedClient) (storedClient as any).name = displayName;
    // Auto-register in unified target registry
    if ((this as any).registerTarget) {
      (this as any).registerTarget(displayName, actualTransport, channelId, "channel");
    }
    this.addConnection(storeUrl, displayName, connectionConfig).catch(() => {});
    process.stderr.write(`[${this.name}] Connected to ${resolvedUrl} via ${actualTransport} as "${displayName}"\n`);

    // Include public key only for remote hub-to-hub (WS) connections for E2E encryption
    let publicKey: string | undefined;
    if (transportRequiresE2E(actualTransport)) {
      try {
        const { loadOrCreateIdentity } = await import("./mesh.js");
        const { getTalonHome } = await import("./hub-settings.js");
        if (!(this as any)._identity) (this as any)._identity = await loadOrCreateIdentity(getTalonHome());
        publicKey = (this as any)._identity.publicKey;
      } catch {}
    }
    await transport.send({ type: "register", agent_name: name, tools: (this as any).clientTools, metadata: publicKey ? { publicKey } : undefined } as any);

    // Heartbeat
    heartbeatTimer = setInterval(() => {
      const current = this.clients.get(storeUrl);
      if (!current || current.id !== clientId || !transport.connected) {
        clearHeartbeat();
        return;
      }
      transport.send({ type: "heartbeat" } as any).catch(() => {});
    }, 15000);
    const client = this.clients.get(storeUrl);
    if (client) client.heartbeatTimer = heartbeatTimer;

    this.emit("connected", { url: resolvedUrl, transport: actualTransport, name: displayName });
  };

  (Hub.prototype as any).handleClientToolCall = async function(this: ChannelHub, msg: any, transport: any): Promise<void> {
    const toolArgs = typeof msg.args === "string" ? JSON.parse(msg.args) : (msg.args ?? {});
    try {
      let result: unknown;
      if ((this as any).opts.onToolCall) { result = await (this as any).opts.onToolCall(msg.tool_name, toolArgs); }
      else result = { error: `Unknown tool: ${msg.tool_name}` };
      await transport.send({ type: "tool_result", call_id: msg.call_id, result });
    } catch (e) { await transport.send({ type: "tool_result", call_id: msg.call_id, error: String(e) }); }
  };
}
