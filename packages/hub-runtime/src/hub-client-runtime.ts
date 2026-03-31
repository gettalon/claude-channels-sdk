/**
 * HubClientRuntime — Client connection and transport selection for ChannelHub.
 *
 * Extracted from hub-client.ts as proper instance methods on a class.
 * Part of the architecture refactor: Stage 2 — Extract HubClientRuntime.
 */
import { transportRequiresE2E } from "@gettalon/protocol";
import { HubConfigService } from "./hub-config-service.js";

export class HubClientRuntime {
  constructor(private hub: any) {}

  // ── Transport helpers ──────────────────────────────────────────────────

  private detectTransport(url: string): string {
    if (url.startsWith("ws://") || url.startsWith("wss://")) return "websocket";
    if (url.startsWith("unix://") || url.startsWith("/")) return "unix";
    if (url.startsWith("telegram://")) return "telegram";
    if (url.startsWith("auto://")) return "auto";
    return "websocket";
  }

  private isLocalUrl(url: string): boolean {
    try {
      const parseable = url.startsWith("auto://") ? url.replace("auto://", "ws://") : url;
      const u = new URL(parseable);
      return u.hostname === "localhost" || u.hostname === "127.0.0.1";
    } catch {
      return false;
    }
  }

  private extractPort(url: string): number | null {
    try {
      const parseable = url.startsWith("auto://") ? url.replace("auto://", "ws://") : url;
      const u = new URL(parseable);
      return u.port ? parseInt(u.port, 10) : null;
    } catch {
      return null;
    }
  }

  private autoToWsUrl(url: string): string {
    return url.replace(/^auto:\/\//, "ws://");
  }

  // ── Main connect method ────────────────────────────────────────────────

  async connect(url: string, agentName?: string, connectionConfig?: Record<string, unknown>): Promise<void> {
    const hub = this.hub;
    await hub.ensureMachineId();
    const name = agentName ?? hub.opts.agentName ?? HubConfigService.fromEnv().envAgentName ?? hub.name ?? hub.randomAgentName();
    // Also check if a resolved form of this URL is already connected
    // (prevents auto://, ws://localhost, unix:// duplicates to the same hub)
    const port = this.extractPort(url);
    const findExisting = () => {
      if (hub.clients.has(url)) return hub.clients.get(url);
      if (port) {
        const aliases = [`auto://localhost:${port}`, `ws://localhost:${port}`, `unix:///tmp/talon-${port}.sock`];
        for (const alias of aliases) {
          if (alias !== url && hub.clients.has(alias)) return hub.clients.get(alias);
        }
      }
      return undefined;
    };
    const existing = findExisting();
    if (existing) {
      // Already connected — resend register to get a fresh register_ack with updated discovery info
      try { existing.ws.send(JSON.stringify({ type: "register", agent_name: name, tools: hub.clientTools })); } catch {}
      return;
    }

    let transportType = this.detectTransport(url);
    const preferLocal = hub.opts.preferLocalIpc !== false; // default true

    // ── Auto-transport selection ──────────────────────────────────────
    // auto:// scheme: let SDK pick the best transport
    // ws://localhost or ws://127.0.0.1: try unix socket first when preferLocalIpc is true
    const isAuto = transportType === "auto";
    const isLocalWs = transportType === "websocket" && this.isLocalUrl(url);
    const shouldTryUnix = (isAuto || isLocalWs) && preferLocal;

    let resolvedUrl = isAuto ? this.autoToWsUrl(url) : url;
    let actualTransport = transportType === "auto" ? "websocket" : transportType;

    if (shouldTryUnix) {
      const port = this.extractPort(url);
      if (port) {
        const socketPath = `/tmp/talon-${port}.sock`;
        const unixUrl = `unix://${socketPath}`;
        try {
          // Attempt unix socket connection
          await import("./transports-compat.js");
          const { createChannel: createCh } = await import("@gettalon/protocol");
          const unixAdapter = createCh("unix", {});
          const testTransport = await unixAdapter.connect(unixUrl, () => {});
          // Success — use unix socket
          await testTransport.close();
          resolvedUrl = unixUrl;
          actualTransport = "unix";
          process.stderr.write(`[${hub.name}] Auto-selected unix socket for local connection\n`);
        } catch {
          // Unix socket not available — fall back to WS
          actualTransport = "websocket";
          process.stderr.write(`[${hub.name}] Unix socket unavailable, falling back to WebSocket\n`);
        }
      }
    }

    await import("./transports-compat.js");
    const { createChannel } = await import("@gettalon/protocol");
    const settings = await hub.loadSettings();
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
      (transportConfig as any).botToken = HubConfigService.fromEnv().telegramBotToken();
    }

    const adapter = createChannel(actualTransport, transportConfig as Record<string, unknown>);
    const transport = await adapter.connect(resolvedUrl, (msg: any) => {
      // ── E2E decryption: unwrap encrypted messages ──
      if (msg.type === "e2e" && msg.e2e) {
        // Find session by server name (the hub we're connected to)
        const session = [...hub.e2eSessions.values()][0]; // client has at most one server session
        if (session) {
          try {
            const decrypted = session.decrypt(msg.e2e);
            msg = typeof decrypted === "string" ? JSON.parse(decrypted) : decrypted;
          } catch (e: any) {
            process.stderr.write(`[${hub.name}] E2E decrypt failed: ${e.message}\n`);
            return;
          }
        } else {
          process.stderr.write(`[${hub.name}] Received e2e message but no session\n`);
          return;
        }
      }
      // ── Key exchange: hub sends its public key ──
      if (msg.type === "key_exchange" && msg.publicKey) {
        (async () => {
          try {
            const { E2eSession, loadOrCreateIdentity } = await import("./mesh-compat.js");
            const { getTalonHome } = await import("./hub-settings.js");
            if (!hub._identity) hub._identity = await loadOrCreateIdentity(getTalonHome());
            const identity = hub._identity;
            const hubName = name ?? "hub";
            hub.peerKeys.set(hubName, msg.publicKey);
            hub.e2eSessions.set(hubName, E2eSession.fromKeyExchange(identity.privateKey, msg.publicKey, hub.name));
            process.stderr.write(`[${hub.name}] E2E session established with hub\n`);
          } catch (e: any) {
            process.stderr.write(`[${hub.name}] Key exchange failed: ${e.message}\n`);
          }
        })();
        return;
      }
      if (msg.type === "ack") return;

      // ── Pairing flow: handle register_ack status from server ──
      if (msg.type === "register_ack") {
        if (msg.status === "pending_approval") {
          process.stderr.write(`[${hub.name}] Approval required by server. Pairing code: ${msg.message ?? "unknown"}\n`);
          hub.emit("approvalPending", { message: msg.message, url: resolvedUrl, transport: actualTransport });
          hub.emit("message", {
            content: `Pending approval from server. ${msg.message ?? ""}`,
            chatId: "system", user: "system", type: "system", source: hub.name,
          });
        } else if (msg.status === "denied") {
          process.stderr.write(`[${hub.name}] Connection denied by server: ${msg.message ?? ""}\n`);
          hub.emit("approvalDenied", { message: msg.message, url: resolvedUrl });
          hub.emit("message", {
            content: `Connection denied by server. ${msg.message ?? ""}`,
            chatId: "system", user: "system", type: "system", source: hub.name,
          });
        } else if (msg.status === "ok") {
          // Approved (either immediately or after pending)
          process.stderr.write(`[${hub.name}] Registered with server as agent "${msg.agent_id ?? name}"\n`);
          hub.emit("approvalGranted", { agentId: msg.agent_id, url: resolvedUrl, info: msg.info });
          // Cache remote discovery info in settings.json
          if (msg.info) {
            (async () => {
              try {
                const settings = await hub.loadSettings();
                const conn = (settings.connections ?? []).find((c: any) => c.url === storeUrl || c.url === url);
                if (conn) {
                  conn.remoteInfo = { ...msg.info, cachedAt: new Date().toISOString() };
                  await hub.saveSettings(settings);
                  const agentCount = msg.info.agents?.length ?? 0;
                  const groupCount = msg.info.groups?.length ?? 0;
                  process.stderr.write(`[${hub.name}] Cached remote info: ${agentCount} agent(s), ${groupCount} group(s)\n`);
                }
              } catch (e: any) {
                process.stderr.write(`[${hub.name}] Failed to cache remote info: ${e.message}\n`);
              }
            })();
          }
        }
        return;
      }

      if (msg.type === "tool_call") this.handleClientToolCall(msg, transport);
      if (msg.type === "tool_result") {
        // Resolve a pending proxied tool call
        const p = hub.pendingCalls.get(msg.call_id);
        if (p) { clearTimeout(p.timer); hub.pendingCalls.delete(msg.call_id); p.resolve(msg.error ? { error: msg.error } : msg.result); }
      }
      if (msg.type === "proxy_result") {
        // Resolve a pending proxy command from proxyToServer()
        const p = hub.pendingProxyCalls.get(msg.proxy_id);
        if (p) {
          clearTimeout(p.timer);
          hub.pendingProxyCalls.delete(msg.proxy_id);
          if (msg.error) p.reject(new Error(msg.error));
          else p.resolve(msg.result);
        }
      }
      if (msg.type === "chat" || msg.type === "reply") {
        const rawChatId = msg.chat_id ?? "host";
        const files = msg.files as any[] | undefined;
        const client = hub.clients.get(storeUrl);

        // Register user as an addressable target scoped to this connection (many-to-many safe).
        // UUID conversion only applies to channel-role connections (telegram, slack, etc.)
        // where the same raw chat_id may appear across multiple bots.
        // Server-role connections (hub-to-hub) keep their raw chat_id.
        let chatId = rawChatId;
        const isChannelConn = client?.role === "channel";
        if (rawChatId !== "host" && isChannelConn && hub.registerTarget && client) {
          const user = msg.from ?? rawChatId;
          const uuid = hub.registerTarget(user, actualTransport, rawChatId, "user", storeUrl);
          chatId = uuid;  // MCP layer always sees UUID as chat_id
          // Key channelForChat by UUID for precise multi-bot routing
          if (!hub.channelForChat.has(uuid)) {
            hub.registerChannelForChat(uuid, client);
          }
        } else if (rawChatId !== "host" && client && !hub.channelForChat.has(rawChatId)) {
          // Server-role (hub-to-hub): keep raw chatId so reply() can route back
          hub.registerChannelForChat(rawChatId, client);
        }

        // Client receives chat from server — emit directly, don't re-route through server
        hub.emit("message", { content: msg.content ?? msg.text, chatId, user: msg.from ?? "host", type: "chat", source: resolvedUrl, ...(files?.length ? { files } : {}), ...(chatId !== rawChatId ? { raw_chat_id: rawChatId } : {}) });
        hub.fireHooks("onMessage", { content: msg.content ?? msg.text, chatId, user: msg.from ?? "host", type: "chat" }).catch(() => {});
      }
      if (msg.type === "group_broadcast") {
        hub.emit("message", { content: msg.content, chatId: msg.meta?.group ?? "group", user: msg.from ?? "unknown", type: "chat" });
        hub.fireHooks("onMessage", { content: msg.content, chatId: msg.meta?.group ?? "group", user: msg.from ?? "unknown", type: "chat" }).catch(() => {});
      }
      if (msg.type === "stream_start" || msg.type === "stream_chunk" || msg.type === "stream_end") {
        hub.emit("stream", msg);
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
    hub.registerClient(storeUrl, {
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
    const storedClient = hub.clients.get(storeUrl);
    if (storedClient) (storedClient as any).name = displayName;
    // Auto-register in unified target registry
    if (hub.registerTarget) {
      hub.registerTarget(displayName, actualTransport, channelId, "channel");
    }
    hub.addConnection(storeUrl, displayName, connectionConfig).catch(() => {});
    process.stderr.write(`[${hub.name}] Connected to ${resolvedUrl} via ${actualTransport} as "${displayName}"\n`);

    // Include public key only for remote hub-to-hub (WS) connections for E2E encryption
    let publicKey: string | undefined;
    if (transportRequiresE2E(actualTransport)) {
      try {
        const { loadOrCreateIdentity } = await import("./mesh-compat.js");
        const { getTalonHome } = await import("./hub-settings.js");
        if (!hub._identity) hub._identity = await loadOrCreateIdentity(getTalonHome());
        publicKey = hub._identity.publicKey;
      } catch {}
    }
    await transport.send({ type: "register", agent_name: name, tools: hub.clientTools, metadata: publicKey ? { publicKey } : undefined } as any);

    // Heartbeat
    heartbeatTimer = setInterval(() => {
      const current = hub.clients.get(storeUrl);
      if (!current || current.id !== clientId || !transport.connected) {
        clearHeartbeat();
        return;
      }
      transport.send({ type: "heartbeat" } as any).catch(() => {});
    }, 15000);
    const client = hub.clients.get(storeUrl);
    if (client) client.heartbeatTimer = heartbeatTimer;

    hub.emit("connected", { url: resolvedUrl, transport: actualTransport, name: displayName });
  }

  // ── Client tool call handler ───────────────────────────────────────────

  async handleClientToolCall(msg: any, transport: any): Promise<void> {
    const hub = this.hub;
    const toolArgs = typeof msg.args === "string" ? JSON.parse(msg.args) : (msg.args ?? {});
    try {
      let result: unknown;
      if (hub.opts.onToolCall) { result = await hub.opts.onToolCall(msg.tool_name, toolArgs); }
      else result = { error: `Unknown tool: ${msg.tool_name}` };
      await transport.send({ type: "tool_result", call_id: msg.call_id, result });
    } catch (e) { await transport.send({ type: "tool_result", call_id: msg.call_id, error: String(e) }); }
  }
}
