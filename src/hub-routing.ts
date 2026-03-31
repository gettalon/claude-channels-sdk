/**
 * hub-routing.ts — Message sending, routing, envelope, and handover.
 * Extracted from hub.ts (lines 471–617, 619–707, 1022–1075).
 */
import { createEnvelope } from "./protocol.js";
import type { SessionEnvelope, RecipientFilter, RichMessageParams } from "./protocol.js";
import type { ChannelHub, AgentState, ContactEntry, ContactChannel, TargetEntry } from "./hub.js";
import { createHash, randomUUID } from "node:crypto";

/** Check if an agent is authorized to use a channel. Returns error string or null if allowed. */
function checkChannelAuth(hub: ChannelHub, agentId: string, channelTransport: string): string | null {
  const agent = hub.agents.get(agentId);
  if (!agent || !agent.allowedChannels?.length) return null; // no restrictions
  if (agent.allowedChannels.includes(channelTransport)) return null; // allowed
  return `Agent "${agent.name}" not authorized for ${channelTransport} channel`;
}

/** Check if an agent is authorized to communicate with another agent. Returns error string or null. */
function checkAgentAuth(hub: ChannelHub, senderAgentId: string, targetAgentId: string): string | null {
  const sender = hub.agents.get(senderAgentId);
  const target = hub.agents.get(targetAgentId);
  if (!sender || !target) return null; // can't check, allow
  // Check sender's allowedAgents
  if (sender.allowedAgents?.length && !sender.allowedAgents.includes(target.name) && !sender.allowedAgents.includes(targetAgentId)) {
    return `Agent "${sender.name}" not authorized to communicate with "${target.name}"`;
  }
  // Check target's allowedAgents (bidirectional)
  if (target.allowedAgents?.length && !target.allowedAgents.includes(sender.name) && !target.allowedAgents.includes(senderAgentId)) {
    return `Agent "${target.name}" does not accept messages from "${sender.name}"`;
  }
  return null;
}

/** Install routing methods onto the ChannelHub prototype. */
export function installRouting(Hub: typeof ChannelHub): void {

  /** Generate a deterministic UUID from (channelType, rawId[, sourceUrl]) — stable across restarts.
   *  sourceUrl disambiguates same rawId across multiple bots/channels. */
  function targetUuid(channelType: string, rawId: string, sourceUrl?: string): string {
    const key = sourceUrl ? `${channelType}:${rawId}:${sourceUrl}` : `${channelType}:${rawId}`;
    return createHash("sha256").update(key).digest("hex").slice(0, 12);
  }

  /**
   * Register or update a target in the unified registry.
   * Returns the target's UUID. sourceUrl scopes the UUID to a specific bot/channel connection.
   */
  (Hub.prototype as any).registerTarget = function(
    this: ChannelHub,
    name: string,
    channelType: string,
    rawId: string,
    kind: TargetEntry["kind"],
    sourceUrl?: string,
  ): string {
    const uuid = targetUuid(channelType, rawId, sourceUrl);
    const entry: TargetEntry = { uuid, name, channelType, rawId, kind, ...(sourceUrl ? { sourceUrl } : {}) };
    this.targetRegistry.set(uuid, entry);
    // Index by name for fast lookup (last write wins if names collide)
    this.targetNameIndex.set(name.toLowerCase(), uuid);
    // Also index by qualified name "channelType:name"
    this.targetNameIndex.set(`${channelType}:${name}`.toLowerCase(), uuid);
    return uuid;
  };

  /** Resolve a name or UUID to a TargetEntry. Returns undefined if not found. */
  (Hub.prototype as any).findTarget = function(this: ChannelHub, nameOrUuid: string): TargetEntry | undefined {
    const key = nameOrUuid.toLowerCase();
    const uuid = this.targetNameIndex.get(key) ?? (this.targetRegistry.has(nameOrUuid) ? nameOrUuid : null);
    return uuid ? this.targetRegistry.get(uuid) : undefined;
  };

  /** Get the display name for a chat_id. Returns the target name if registered, else original. */
  (Hub.prototype as any).displayName = function(this: ChannelHub, chatId: string): string {
    // Check by UUID first
    const byUuid = this.targetRegistry.get(chatId);
    if (byUuid) return byUuid.name;
    // Check by name
    const byName = this.targetNameIndex.get(chatId.toLowerCase());
    if (byName) {
      const entry = this.targetRegistry.get(byName);
      if (entry) return entry.name;
    }
    // Check clients
    const client = [...this.clients.values()].find(c => c.channelId === chatId || c.url?.includes(chatId));
    if (client?.name) return client.name;
    // Fallback: return original
    return chatId;
  };

  /** Resolved display name for outgoing messages from this hub. */
  (Hub.prototype as any).resolvedName = function(this: ChannelHub): string {
    return this.clientConnected() ? ((this as any).opts.agentName ?? this.name) : this.name;
  };

  /** Remove a chat route and its associated channel entry, then persist. */
  (Hub.prototype as any).clearRoute = function(this: ChannelHub, chatId: string): void {
    this.chatRoutes.delete(chatId);
    this.channelForChat.delete(chatId);
    this.persistState().catch(() => {});
  };

  /** Emit a chat message to host and fire hooks. */
  (Hub.prototype as any).emitMessage = function(this: ChannelHub, content: string, chatId: string, user: string, extra?: Record<string, unknown>): void {
    this.emit("message", { content, chatId, user, type: "chat", ...extra });
    this.fireHooks("onMessage", { content, chatId, user, type: "chat", ...extra }).catch(() => {});
  };

  /** Resolve a target name to a raw ID via the unified target registry.
   *  Falls back to legacy resolution (contacts, clients, agents, chatRoutes).
   */
  (Hub.prototype as any).resolveTarget = function(this: ChannelHub, target: string): string {
    // Strip channel: prefix if present
    const name = target.startsWith("channel:") ? target.slice("channel:".length) : target;

    // 1. Target registry (unified UUID system)
    const found = (this as any).findTarget(name);
    if (found) {
      process.stderr.write(`[${this.name}] Target resolved: "${target}" -> ${found.channelType}:${found.rawId} (uuid: ${found.uuid})\n`);
      return found.rawId;
    }

    // 2. Contact registry (legacy)
    const contact = this.resolveContact(target);
    if (contact) {
      process.stderr.write(`[${this.name}] Contact resolved: "${target}" -> ${contact.channel.type}:${contact.channel.id}\n`);
      return contact.channel.id;
    }

    // 3. Match clients by name, transport, or URL fragment
    for (const [url, client] of this.clients) {
      if (client.name === name || client.transport === name || url.includes(name) || client.channelId.endsWith(`:${name}`)) {
        process.stderr.write(`[${this.name}] Resolved: "${target}" -> client ${client.transport}:${url} (${client.channelId})\n`);
        return client.channelId;
      }
    }

    // 4. Match agents by name or ID
    const agent = this.findAgent(name);
    if (agent) {
      process.stderr.write(`[${this.name}] Resolved: "${target}" -> agent "${agent.name}" (${agent.id})\n`);
      return agent.id;
    }

    // 5. Match channelForChat by transport or channelId fragment
    for (const [chatId, client] of this.channelForChat) {
      if (client.transport === name || client.channelId.endsWith(`:${name}`)) {
        process.stderr.write(`[${this.name}] Resolved: "${target}" -> chatId ${chatId} (${client.transport})\n`);
        return chatId;
      }
    }

    // 6. Match chatRoutes by fragment
    for (const [chatId] of this.chatRoutes) {
      if (chatId.includes(name)) {
        process.stderr.write(`[${this.name}] Resolved: "${target}" -> route ${chatId}\n`);
        return chatId;
      }
    }

    // 7. No match — return original (could be raw UUID)
    return target;
  };

  /** Try to send to a routed agent. Returns true if the route existed (even if stale). */
  (Hub.prototype as any).trySendToRoute = function(this: ChannelHub, chatId: string, content: string, from: string, rich?: RichMessageParams): boolean {
    const routedAgentId = this.chatRoutes.get(chatId);
    if (!routedAgentId) return false;
    const routedAgent = this.agents.get(routedAgentId);
    if (routedAgent) {
      this.wsSend(routedAgent.ws, { type: "chat", chat_id: chatId, content, from, ...rich });
    } else {
      (this as any).clearRoute(chatId);
    }
    return !!routedAgent;
  };

  Hub.prototype.sendMessage = function(this: ChannelHub, target: string | undefined, content: string, rich?: RichMessageParams): { ok: boolean; error?: string } {
    if (!target) return { ok: false, error: "Target required" };
    const myName = (this as any).resolvedName();
    const resolved = (this as any).resolveTarget(target);
    if ((this as any).trySendToRoute(resolved, content, myName, rich)) return { ok: true };
    const agent = this.findAgent(resolved);
    if (agent) {
      this.wsSend(agent.ws, { type: "chat", chat_id: agent.id, content, from: myName, ...rich });
      return { ok: true };
    }
    // Try known originating channel for this target
    const knownChannel = this.channelForChat.get(resolved);
    if (knownChannel) {
      (this as any).wsSendAsync(knownChannel.ws, { type: "chat", chat_id: resolved, content, from: myName, ...rich });
      return { ok: true };
    }
    // Try any channel client
    for (const [, client] of this.clients) {
      if (client.role === "channel") {
        (this as any).wsSendAsync(client.ws, { type: "chat", chat_id: resolved, content, from: myName, ...rich });
        return { ok: true };
      }
    }
    // Proxy to all connected hub peers — each will deliver if it has the target agent locally
    const hubPeers = [...this.clients.values()].filter(c => c.role === "server");
    if (hubPeers.length > 0) {
      const msgId = (rich as any)?.msgId ?? randomUUID();
      for (const peer of hubPeers) {
        this.wsSend(peer.ws, { type: "chat", target: resolved, content, from: myName, ...rich, msgId });
      }
      return { ok: true };
    }
    // Buffer message for offline agent — it will be flushed when the agent connects
    // Use agent name as buffer key (not ID) so flushBufferedMessages(agentName) can find it
    const agentByName = this.findAgent(resolved);
    const bufferKey = agentByName ? agentByName.name : target; // prefer name, fall back to original target
    this.bufferMessage(bufferKey, content, myName, rich);
    return { ok: true, error: undefined };
  };

  Hub.prototype.reply = function(this: ChannelHub, chatId: string, text: string, rich?: RichMessageParams): { ok: boolean; error?: string } {
    const myName = (this as any).resolvedName();
    const resolved = (this as any).resolveTarget(chatId);
    if ((this as any).trySendToRoute(resolved, text, myName, rich)) return { ok: true };
    const agent = this.findAgent(resolved);
    if (agent) {
      this.wsSend(agent.ws, { type: "reply", chat_id: resolved, text, from: myName, ...rich });
      return { ok: true };
    }
    // UUID fast path: if chatId was a UUID with a known sourceUrl, route directly to that client
    const targetEntry = (this as any).findTarget(chatId);
    if (targetEntry?.sourceUrl) {
      const sourceClient = this.clients.get(targetEntry.sourceUrl);
      if (sourceClient) {
        process.stderr.write(`[${this.name}] reply: UUID route -> ${targetEntry.sourceUrl}\n`);
        const replyPayload = { type: "reply", chat_id: resolved, content: text, text, from: sourceClient.name ?? myName, ...rich };
        (this as any).wsSendAsync(sourceClient.ws, replyPayload);
        return { ok: true };
      }
    }

    // Try the known originating channel for this chatId (keyed by UUID or rawId)
    const knownChannel = this.channelForChat.get(chatId) ?? this.channelForChat.get(resolved);
    if (knownChannel) {
      process.stderr.write(`[${this.name}] reply: sending to channelForChat ${knownChannel.transport}:${knownChannel.url}\n`);
      const replyPayload = { type: "reply", chat_id: resolved, content: text, text, from: knownChannel.name ?? myName, ...rich };
      (this as any).wsSendAsync(knownChannel.ws, replyPayload);
      return { ok: true };
    }
    // Try sending through a channel client that matches this chatId
    for (const [, client] of this.clients) {
      if (client.channelId?.includes(resolved) || client.url?.includes(resolved)) {
        process.stderr.write(`[${this.name}] reply: sending to matched client ${client.transport}:${client.url}\n`);
        const replyPayload = { type: "reply", chat_id: resolved, content: text, text, from: client.name ?? myName, ...rich };
        (this as any).wsSendAsync(client.ws, replyPayload);
        return { ok: true };
      }
    }
    // Try any channel client whose transport might reach this chatId
    // (e.g. Telegram bot can send to any chatId via the same bot token)
    for (const [, client] of this.clients) {
      if (client.role === "channel") {
        process.stderr.write(`[${this.name}] reply: sending to channel client ${client.transport}:${client.url}\n`);
        const replyPayload = { type: "reply", chat_id: resolved, content: text, text, from: client.name ?? myName, ...rich };
        (this as any).wsSendAsync(client.ws, replyPayload);
        return { ok: true };
      }
    }
    // Proxy to all connected hub peers — each will deliver if it has the target agent locally
    const hubPeers = [...this.clients.values()].filter(c => c.role === "server");
    if (hubPeers.length > 0) {
      const msgId = (rich as any)?.msgId ?? randomUUID();
      for (const peer of hubPeers) {
        this.wsSend(peer.ws, { type: "chat", chat_id: resolved, target: resolved, content: text, from: myName, ...rich, msgId });
      }
      return { ok: true };
    }
    return { ok: false, error: "No route" };
  };

  // ── Unified Chat Routing ──────────────────────────────────────────────

  /**
   * Central routing for incoming chat messages (from agents or channels).
   *
   * Priority:
   *   1. Strip bot mention (@BotUsername)
   *   2. @agent bypass — direct to named agent
   *   3. Intent-based routing — match content keywords against agent intents
   *   4. handover-owner-reply — route owner replies back through originating channel
   *   5. chatRoute dispatch — forward to assigned agent
   *   6. broadcast — emit to host
   */
  (Hub.prototype as any).routeChat = function(this: ChannelHub, params: {
    chatId: string;
    content: string;
    from: string;
    source: "agent" | "channel";
    senderAgentId?: string;
    /** URL of the originating channel client (e.g. "telegram://main-bot") for precise routing */
    sourceUrl?: string;
  }): void {
    const { chatId, from, source, senderAgentId, sourceUrl } = params;
    let content = params.content;

    if (from && chatId) {
      const channelType = source === "channel"
        ? (this.channelForChat.get(chatId)?.transport ?? (this as any).inferChannelType(chatId))
        : "agent";
      this.autoRegisterContact(from, chatId, channelType);
    }

    // Track originating channel client for this chatId so replies can route back
    if (source === "channel" && chatId && !this.channelForChat.has(chatId)) {
      // Use sourceUrl for precise match when multiple channels are connected (many-to-many)
      const channelClient = (sourceUrl ? this.clients.get(sourceUrl) : undefined)
        ?? [...this.clients.values()].find(c => c.role === "channel" && (!sourceUrl || c.url === sourceUrl))
        ?? [...this.clients.values()].find(c => c.role === "channel");
      if (channelClient) this.channelForChat.set(chatId, channelClient);
    }

    // 1. Strip bot/hub mention (e.g. "@HomeClaudeh_bot hello" -> "hello")
    //    Supports multiple bot usernames and the hub's own name
    const botNames: string[] = [];
    const botUsername = (this as any).opts?.botUsername as string | undefined;
    if (botUsername) botNames.push(botUsername);
    botNames.push(this.name); // hub name is also a valid mention
    for (const bn of botNames) {
      if (content.startsWith(`@${bn} `) || content.startsWith(`@${bn}\n`) || content === `@${bn}`) {
        content = content.slice(bn.length + 1).trim();
        break;
      }
    }

    // 2. Smart route: @agent mention OR slash command /agent
    //    Works on ALL channels (WS, Unix, Telegram, Discord, etc.)
    //    "@polymarket odds?" or "/polymarket odds?" -> route to polymarket agent
    const agentMention = content.match(/^[@/](\S+)\s*(.*)/s);
    if (agentMention) {
      const [, mentionedName, restContent] = agentMention;
      const targetAgent = this.findAgent(mentionedName);
      if (targetAgent) {
        // Enforce allowedAgents when sender is an agent
        if (senderAgentId) {
          const authErr = checkAgentAuth(this, senderAgentId, targetAgent.id);
          if (authErr) {
            const senderAgent = this.agents.get(senderAgentId);
            if (senderAgent) this.wsSend(senderAgent.ws, { type: "ack", ref: "agent_auth", status: "error", reason: authErr });
            this.emit("agentDenied", { senderId: senderAgentId, targetId: targetAgent.id, reason: authErr });
            return;
          }
        }
        const deliverContent = restContent.trim() || content;
        this.wsSend(targetAgent.ws, { type: "chat", chat_id: chatId, content: deliverContent, from });
        // Auto-handover so replies go back through the originating channel
        if (!this.chatRoutes.has(chatId)) {
          this.chatRoutes.set(chatId, targetAgent.id);
          const channelClient = this.channelForChat.get(chatId) ?? (sourceUrl ? this.clients.get(sourceUrl) : undefined) ?? [...this.clients.values()].find(c => c.role === "channel");
          if (channelClient) this.channelForChat.set(chatId, channelClient);
        }
        this.emit("smartRoute", { chatId, agentName: mentionedName, agentId: targetAgent.id, source });
        process.stderr.write(`[${this.name}] Smart route: @${mentionedName} -> agent "${targetAgent.name}" (via ${source})\n`);
        return;
      }
      // Check persistent agents (Claude Agent SDK in-memory agents)
      if ((this as any)._persistentAgentRouter) {
        const routed = (this as any)._persistentAgentRouter(mentionedName, restContent.trim() || content, from, chatId);
        if (routed) {
          this.emit("smartRoute", { chatId, agentName: mentionedName, agentId: `persistent:${mentionedName}`, source });
          process.stderr.write(`[${this.name}] Smart route: @${mentionedName} -> persistent agent "${mentionedName}" (via ${source})\n`);
          return;
        }
      }
    }

    // 3. Intent-based routing: match message content against agent intents/keywords
    //    Only applies when no @mention was used and no existing route exists
    if (!this.chatRoutes.has(chatId)) {
      const tokens = content.toLowerCase().split(/\s+/);
      let bestAgent: AgentState | undefined;
      let bestScore = 0;
      const matches: Array<{ agentId: string; agentName: string; score: number; matched: string[] }> = [];

      for (const agent of this.agents.values()) {
        if (!agent.intents?.length) continue;
        const lowIntents = agent.intents.map(i => i.toLowerCase());
        const matched: string[] = [];
        for (const token of tokens) {
          if (lowIntents.includes(token)) matched.push(token);
        }
        if (matched.length > 0) {
          matches.push({ agentId: agent.id, agentName: agent.name, score: matched.length, matched });
          if (matched.length > bestScore) {
            bestScore = matched.length;
            bestAgent = agent;
          }
        }
      }

      if (bestAgent) {
        this.wsSend(bestAgent.ws, { type: "chat", chat_id: chatId, content, from });
        // Auto-handover so replies go back through the originating channel
        this.chatRoutes.set(chatId, bestAgent.id);
        const channelClient = this.channelForChat.get(chatId) ?? [...this.clients.values()].find(c => c.role === "channel");
        if (channelClient) this.channelForChat.set(chatId, channelClient);
        this.emit("intentRoute", { chatId, agentName: bestAgent.name, agentId: bestAgent.id, source, matches, bestScore });
        process.stderr.write(`[${this.name}] Intent route: "${bestAgent.name}" matched ${bestScore} keyword(s) (via ${source})\n`);
        return;
      }
    }

    // 4. Handover-owner-reply: agent that owns the route replies back through originating channel
    if (source === "agent" && senderAgentId) {
      const routeOwner = this.chatRoutes.get(chatId);
      if (routeOwner === senderAgentId) {
        const channelClient = this.channelForChat.get(chatId);
        if (channelClient) {
          // Check channel authorization
          const authError = checkChannelAuth(this, senderAgentId, channelClient.transport);
          if (authError) {
            const agent = this.agents.get(senderAgentId);
            if (agent) this.wsSend(agent.ws, { type: "ack", ref: "channel_auth", status: "error", reason: authError });
            this.emit("channelDenied", { agentId: senderAgentId, agentName: agent?.name, channel: channelClient.transport, action: "reply" });
            return;
          }
          this.wsSend(channelClient.ws, { type: "chat", chat_id: chatId, content, from });
        }
        (this as any).emitMessage(content, chatId, from);
        return;
      }
    }

    // ChatRoute dispatch: forward to assigned agent, or clean up stale route
    if ((this as any).trySendToRoute(chatId, content, from)) return;

    // Broadcast to host
    (this as any).emitMessage(content, chatId, from);
  };

  // ── Envelope & EventRouter ──────────────────────────────────────────────

  /**
   * Wrap a protocol message in a SessionEnvelope.
   * Infers the envelope `type` from the message's `type` field.
   */
  Hub.prototype.wrapEnvelope = function(this: ChannelHub, payload: any, opts?: { to?: string; session?: string }): SessionEnvelope {
    const myName = (this as any).resolvedName();
    const msgType = payload?.type as string | undefined;
    let envelopeType: SessionEnvelope["type"] = "system";
    if (msgType === "chat" || msgType === "reply") envelopeType = "chat";
    else if (msgType === "tool_call" || msgType === "tool_call_proxy") envelopeType = "tool_call";
    else if (msgType === "tool_result") envelopeType = "tool_result";
    else if (msgType === "invite" || msgType === "group_broadcast") envelopeType = "handover";
    return createEnvelope(myName, envelopeType, payload, opts);
  };

  /**
   * Route a SessionEnvelope to recipients based on a RecipientFilter.
   */
  Hub.prototype.route = function(this: ChannelHub, envelope: SessionEnvelope, filter: RecipientFilter = "broadcast"): number {
    let delivered = 0;

    // Determine whether we should send to agents
    const sendToAgents = filter === "broadcast" || filter === "agent-only" || filter === "session-scoped";
    // Determine whether we should send to host/clients
    const sendToHost = filter === "broadcast" || filter === "host-only";

    if (sendToAgents) {
      if (filter === "session-scoped") {
        // Scoped: try envelope.to first, then chatRoutes for the session
        let targetAgent: AgentState | undefined;
        if (envelope.to) {
          targetAgent = this.findAgent(envelope.to);
        } else if (envelope.session) {
          const routedId = this.chatRoutes.get(envelope.session);
          if (routedId) targetAgent = this.agents.get(routedId);
        }
        if (targetAgent) {
          this.wsSend(targetAgent.ws, envelope.payload);
          delivered++;
        }
      } else {
        // broadcast or agent-only: send to all agents (or just the targeted one)
        if (envelope.to) {
          const target = this.findAgent(envelope.to);
          if (target) {
            this.wsSend(target.ws, envelope.payload);
            delivered++;
          }
        } else {
          for (const agent of this.agents.values()) {
            this.wsSend(agent.ws, envelope.payload);
            delivered++;
          }
        }
      }
    }

    if (sendToHost) {
      if (envelope.to) {
        // If there's a specific target and it wasn't found in agents,
        // try forwarding through the host client
        const cws = this.getClientWs();
        if (cws) {
          this.wsSend(cws, envelope.payload);
          delivered++;
        }
      } else {
        // Broadcast to all client connections
        for (const client of this.clients.values()) {
          this.wsSend(client.ws, envelope.payload);
          delivered++;
        }
      }
    }

    this.emit("routed", { envelope, filter, delivered });
    return delivered;
  };

  // ── Chat Handover ─────────────────────────────────────────────────────

  /** Assign a chat to a specific agent. Future messages for this chat_id go to that agent. */
  Hub.prototype.handover = function(this: ChannelHub, chatId: string, toAgentId: string): { ok: boolean; error?: string } | Promise<{ ok: boolean; error?: string }> {
    if (this.isClient()) {
      return (this as any).proxyToServer("handover", { chatId, toAgentId });
    }
    const agent = this.findAgent(toAgentId);
    if (!agent) return { ok: false, error: "Agent not found" };
    // Check channel authorization before handover
    const channelClient = [...this.clients.values()].find(c => c.channelId === chatId || c.channelId.endsWith(`:${chatId}`));
    if (channelClient && agent.allowedChannels?.length) {
      if (!agent.allowedChannels.includes(channelClient.transport)) {
        this.emit("channelDenied", { agentId: agent.id, agentName: agent.name, channel: channelClient.transport, action: "handover" });
        return { ok: false, error: `Agent "${agent.name}" not authorized for ${channelClient.transport} channel` };
      }
    }
    this.chatRoutes.set(chatId, agent.id);
    // Persist route to settings
    this.persistState().catch(() => {});

    // Store the originating channel client for this chat so replies can be routed back
    // Look up the client by channelId match (transport:endpoint) rather than substring on URL
    let matchedClient: { url: string; entry: any } | undefined;
    for (const [url, entry] of this.clients) {
      if (entry.channelId === chatId || entry.channelId.endsWith(`:${chatId}`)) {
        matchedClient = { url, entry };
        break;
      }
    }
    if (matchedClient) {
      this.channelForChat.set(chatId, matchedClient.entry);
    }

    const channel = matchedClient ? matchedClient.entry.transport : "unknown";
    const channelUrl = matchedClient ? matchedClient.url : `${channel}://${chatId}`;
    const channelId = matchedClient ? matchedClient.entry.channelId : `${channel}:${chatId}`;
    this.wsSend(agent.ws, { type: "chat", chat_id: chatId, content: `[system] Channel handover: you now own ${channelUrl} (id: ${channelId}). Reply to messages from this channel.`, from: "system", meta: { type: "system", channel, channelId, channelUrl, handover: "true" } });
    this.emit("handover", { chatId, toAgentId: agent.id, toAgentName: agent.name, channel, channelId, channelUrl });
    process.stderr.write(`[${this.name}] Chat "${chatId}" handed over to agent "${agent.name}" (${agent.id})\n`);
    return { ok: true };
  };

  /** Get the agent assigned to a chat, if any. */
  Hub.prototype.getChatRoute = function(this: ChannelHub, chatId: string): string | undefined | Promise<string | undefined> {
    if (this.isClient()) {
      return (this as any).proxyToServer("getChatRoute", { chatId });
    }
    return this.chatRoutes.get(chatId);
  };

  /** Release a chat assignment, returning it to the host. */
  Hub.prototype.releaseChat = function(this: ChannelHub, chatId: string): { ok: boolean; error?: string } | Promise<{ ok: boolean; error?: string }> {
    if (this.isClient()) {
      return (this as any).proxyToServer("releaseChat", { chatId });
    }
    if (!this.chatRoutes.has(chatId)) return { ok: false, error: "No route for this chat" };
    (this as any).clearRoute(chatId);
    process.stderr.write(`[${this.name}] Chat "${chatId}" released back to host\n`);
    return { ok: true };
  };
}
