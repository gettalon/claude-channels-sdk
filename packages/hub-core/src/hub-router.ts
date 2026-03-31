/**
 * HubRouter — Extracted routing logic from hub-routing.ts.
 *
 * All 19 routing methods that were previously monkey-patched onto ChannelHub
 * via installRouting() are now proper instance methods on this class.
 * The hub reference is passed via constructor (simple pass-through for now).
 *
 * Part of the architecture refactor: Step 3 — Extract HubRouter.
 */
import { createEnvelope } from "@gettalon/protocol";
import type { SessionEnvelope, RecipientFilter, RichMessageParams } from "@gettalon/protocol";
import type { AgentState, ContactChannel, ContactEntry, TargetEntry } from "./types.js";
import { createHash, randomUUID } from "node:crypto";

// Re-import ChannelHub type from the root — hub-router depends on ChannelHub's
// public surface. We use a structural type alias here so hub-core doesn't
// depend on the root package at runtime.
/** Minimal ChannelHub surface required by HubRouter. */
export interface HubRouterHost {
  readonly name: string;
  readonly agents: Map<string, AgentState>;
  readonly clients: Map<string, any>;
  readonly chatRoutes: Map<string, string>;
  readonly channelForChat: Map<string, any>;
  readonly targetRegistry: Map<string, TargetEntry>;
  readonly targetNameIndex: Map<string, string>;
  isClient(): boolean;
  clientConnected(): boolean;
  findAgent(idOrName: string): { id: string; name: string; ws: any; allowedChannels?: string[]; allowedAgents?: string[]; intents?: string[]; tools?: any[] } | undefined;
  wsSend(ws: any, data: any): void;
  getClientWs(): any;
  bufferMessage(key: string, content: string, from: string, rich?: RichMessageParams): void;
  emit(event: string, ...args: any[]): boolean;
}

// ── Auth helpers (pure functions, no hub dependency) ─────────────────────

/** Check if an agent is authorized to use a channel. Returns error string or null if allowed. */
function checkChannelAuth(hub: HubRouterHost, agentId: string, channelTransport: string): string | null {
  const agent = hub.agents.get(agentId);
  if (!agent || !agent.allowedChannels?.length) return null;
  if (agent.allowedChannels.includes(channelTransport)) return null;
  return `Agent "${agent.name}" not authorized for ${channelTransport} channel`;
}

/** Check if an agent is authorized to communicate with another agent. Returns error string or null. */
function checkAgentAuth(hub: HubRouterHost, senderAgentId: string, targetAgentId: string): string | null {
  const sender = hub.agents.get(senderAgentId);
  const target = hub.agents.get(targetAgentId);
  if (!sender || !target) return null;
  if (sender.allowedAgents?.length && !sender.allowedAgents.includes(target.name) && !sender.allowedAgents.includes(targetAgentId)) {
    return `Agent "${sender.name}" not authorized to communicate with "${target.name}"`;
  }
  if (target.allowedAgents?.length && !target.allowedAgents.includes(sender.name) && !target.allowedAgents.includes(senderAgentId)) {
    return `Agent "${target.name}" does not accept messages from "${sender.name}"`;
  }
  return null;
}

/** Generate a deterministic UUID from (channelType, rawId[, sourceUrl]) — stable across restarts. */
function targetUuid(channelType: string, rawId: string, sourceUrl?: string): string {
  const key = sourceUrl ? `${channelType}:${rawId}:${sourceUrl}` : `${channelType}:${rawId}`;
  return createHash("sha256").update(key).digest("hex").slice(0, 12);
}

// ── HubRouter ────────────────────────────────────────────────────────────

export class HubRouter {
  constructor(private readonly hub: HubRouterHost) {}

  // ── Registry ──────────────────────────────────────────────────────────

  registerTarget(name: string, channelType: string, rawId: string, kind: TargetEntry["kind"], sourceUrl?: string): string {
    const uuid = targetUuid(channelType, rawId, sourceUrl);
    const entry: TargetEntry = { uuid, name, channelType, rawId, kind, ...(sourceUrl ? { sourceUrl } : {}) };
    this.hub.targetRegistry.set(uuid, entry);
    this.hub.targetNameIndex.set(name.toLowerCase(), uuid);
    this.hub.targetNameIndex.set(`${channelType}:${name}`.toLowerCase(), uuid);
    return uuid;
  }

  findTarget(nameOrUuid: string): TargetEntry | undefined {
    const key = nameOrUuid.toLowerCase();
    const uuid = this.hub.targetNameIndex.get(key) ?? (this.hub.targetRegistry.has(nameOrUuid) ? nameOrUuid : null);
    if (uuid) return this.hub.targetRegistry.get(uuid);
    if (this.hub.agents.has(nameOrUuid)) {
      const agent = this.hub.agents.get(nameOrUuid)!;
      return { uuid: nameOrUuid, name: agent.name, channelType: "agent", rawId: nameOrUuid, kind: "agent" };
    }
    return undefined;
  }

  displayName(chatId: string): string {
    const byUuid = this.hub.targetRegistry.get(chatId);
    if (byUuid) return byUuid.name;
    const byName = this.hub.targetNameIndex.get(chatId.toLowerCase());
    if (byName) {
      const entry = this.hub.targetRegistry.get(byName);
      if (entry) return entry.name;
    }
    const client = [...this.hub.clients.values()].find((c: any) => c.channelId === chatId || c.url?.includes(chatId));
    if (client?.name) return client.name;
    return chatId;
  }

  resolvedName(): string {
    return this.hub.clientConnected() ? ((this.hub as any).opts?.agentName ?? this.hub.name) : this.hub.name;
  }

  // ── Route management ──────────────────────────────────────────────────

  clearRoute(chatId: string): void {
    this.hub.chatRoutes.delete(chatId);
    this.hub.channelForChat.delete(chatId);
    (this.hub as any).persistState?.().catch(() => {});
  }

  getChatRoute(chatId: string): string | undefined | Promise<string | undefined> {
    if (this.hub.isClient()) {
      return (this.hub as any).proxyToServer("getChatRoute", { chatId });
    }
    return this.hub.chatRoutes.get(chatId);
  }

  releaseChat(chatId: string): { ok: boolean; error?: string } | Promise<{ ok: boolean; error?: string }> {
    if (this.hub.isClient()) {
      return (this.hub as any).proxyToServer("releaseChat", { chatId });
    }
    if (!this.hub.chatRoutes.has(chatId)) return { ok: false, error: "No route for this chat" };
    this.clearRoute(chatId);
    process.stderr.write(`[${this.hub.name}] Chat "${chatId}" released back to host\n`);
    return { ok: true };
  }

  // ── Messaging ─────────────────────────────────────────────────────────

  emitMessage(content: string, chatId: string, user: string, extra?: Record<string, unknown>): void {
    this.hub.emit("message", { content, chatId, user, type: "chat", ...extra });
    (this.hub as any).fireHooks?.("onMessage", { content, chatId, user, type: "chat", ...extra })?.catch?.(() => {});
  }

  resolveTarget(target: string): string {
    const name = target.startsWith("channel:") ? target.slice("channel:".length) : target;

    // 1. Target registry (unified UUID system)
    const found = this.findTarget(name);
    if (found) {
      process.stderr.write(`[${this.hub.name}] Target resolved: "${target}" -> ${found.channelType}:${found.rawId} (uuid: ${found.uuid})\n`);
      return found.rawId;
    }

    // 2. Contact registry (legacy)
    const contact = (this.hub as any).resolveContact?.(target);
    if (contact) {
      process.stderr.write(`[${this.hub.name}] Contact resolved: "${target}" -> ${contact.channel.type}:${contact.channel.id}\n`);
      return contact.channel.id;
    }

    // 3. Match clients by name, transport, or URL fragment
    for (const [url, client] of this.hub.clients) {
      if (client.name === name || client.transport === name || url.includes(name) || client.channelId.endsWith(`:${name}`)) {
        process.stderr.write(`[${this.hub.name}] Resolved: "${target}" -> client ${client.transport}:${url} (${client.channelId})\n`);
        return client.channelId;
      }
    }

    // 4. Match agents by name or ID
    const agent = this.hub.findAgent(name);
    if (agent) {
      process.stderr.write(`[${this.hub.name}] Resolved: "${target}" -> agent "${agent.name}" (${agent.id})\n`);
      return agent.id;
    }

    // 5. Match channelForChat by transport or channelId fragment
    for (const [chatId, client] of this.hub.channelForChat) {
      if (client.transport === name || client.channelId.endsWith(`:${name}`)) {
        process.stderr.write(`[${this.hub.name}] Resolved: "${target}" -> chatId ${chatId} (${client.transport})\n`);
        return chatId;
      }
    }

    // 6. Match chatRoutes by fragment
    for (const [chatId] of this.hub.chatRoutes) {
      if (chatId.includes(name)) {
        process.stderr.write(`[${this.hub.name}] Resolved: "${target}" -> route ${chatId}\n`);
        return chatId;
      }
    }

    // 7. No match — return original (could be raw UUID)
    return target;
  }

  trySendToRoute(chatId: string, content: string, from: string, rich?: RichMessageParams): boolean {
    const routedAgentId = this.hub.chatRoutes.get(chatId);
    if (!routedAgentId) return false;
    const routedAgent = this.hub.agents.get(routedAgentId);
    if (routedAgent) {
      this.hub.wsSend(routedAgent.ws, { type: "chat", chat_id: chatId, content, from, ...rich });
    } else {
      this.clearRoute(chatId);
    }
    return !!routedAgent;
  }

  sendMessage(target: string | undefined, content: string, rich?: RichMessageParams): { ok: boolean; error?: string } {
    if (!target) return { ok: false, error: "Target required" };
    const myName = this.resolvedName();
    const resolved = this.resolveTarget(target);
    if (this.trySendToRoute(resolved, content, myName, rich)) return { ok: true };
    const agent = this.hub.findAgent(resolved);
    if (agent) {
      this.hub.wsSend(agent.ws, { type: "chat", chat_id: agent.id, content, from: myName, ...rich });
      return { ok: true };
    }
    const knownChannel = this.hub.channelForChat.get(resolved);
    if (knownChannel) {
      (this.hub as any).wsSendAsync(knownChannel.ws, { type: "chat", chat_id: resolved, content, from: myName, ...rich });
      return { ok: true };
    }
    for (const [, client] of this.hub.clients) {
      if (client.role === "channel") {
        (this.hub as any).wsSendAsync(client.ws, { type: "chat", chat_id: resolved, content, from: myName, ...rich });
        return { ok: true };
      }
    }
    const hubPeers = [...this.hub.clients.values()].filter((c: any) => c.role === "server");
    if (hubPeers.length > 0) {
      const msgId = (rich as any)?.msgId ?? randomUUID();
      for (const peer of hubPeers) {
        this.hub.wsSend(peer.ws, { type: "chat", target: resolved, content, from: myName, ...rich, msgId });
      }
      return { ok: true };
    }
    const agentByName = this.hub.findAgent(resolved);
    const bufferKey = agentByName ? agentByName.name : target;
    this.hub.bufferMessage(bufferKey, content, myName, rich);
    return { ok: true, error: undefined };
  }

  reply(chatId: string, text: string, rich?: RichMessageParams): { ok: boolean; error?: string } {
    const myName = this.resolvedName();
    const resolved = this.resolveTarget(chatId);
    if (this.trySendToRoute(resolved, text, myName, rich)) return { ok: true };
    const agent = this.hub.findAgent(resolved);
    if (agent) {
      this.hub.wsSend(agent.ws, { type: "reply", chat_id: resolved, text, from: myName, ...rich });
      return { ok: true };
    }
    const targetEntry = this.findTarget(chatId);
    if (targetEntry?.sourceUrl) {
      const sourceClient = this.hub.clients.get(targetEntry.sourceUrl);
      if (sourceClient) {
        process.stderr.write(`[${this.hub.name}] reply: UUID route -> ${targetEntry.sourceUrl}\n`);
        const replyPayload = { type: "reply", chat_id: resolved, content: text, text, from: sourceClient.name ?? myName, ...rich };
        (this.hub as any).wsSendAsync(sourceClient.ws, replyPayload);
        return { ok: true };
      }
    }
    const knownChannel = this.hub.channelForChat.get(chatId) ?? this.hub.channelForChat.get(resolved);
    if (knownChannel) {
      process.stderr.write(`[${this.hub.name}] reply: sending to channelForChat ${knownChannel.transport}:${knownChannel.url}\n`);
      const replyPayload = { type: "reply", chat_id: resolved, content: text, text, from: knownChannel.name ?? myName, ...rich };
      (this.hub as any).wsSendAsync(knownChannel.ws, replyPayload);
      return { ok: true };
    }
    for (const [, client] of this.hub.clients) {
      if (client.channelId?.includes(resolved) || client.url?.includes(resolved)) {
        process.stderr.write(`[${this.hub.name}] reply: sending to matched client ${client.transport}:${client.url}\n`);
        const replyPayload = { type: "reply", chat_id: resolved, content: text, text, from: client.name ?? myName, ...rich };
        (this.hub as any).wsSendAsync(client.ws, replyPayload);
        return { ok: true };
      }
    }
    for (const [, client] of this.hub.clients) {
      if (client.role === "channel") {
        process.stderr.write(`[${this.hub.name}] reply: sending to channel client ${client.transport}:${client.url}\n`);
        const replyPayload = { type: "reply", chat_id: resolved, content: text, text, from: client.name ?? myName, ...rich };
        (this.hub as any).wsSendAsync(client.ws, replyPayload);
        return { ok: true };
      }
    }
    const hubPeers = [...this.hub.clients.values()].filter((c: any) => c.role === "server");
    if (hubPeers.length > 0) {
      const msgId = (rich as any)?.msgId ?? randomUUID();
      for (const peer of hubPeers) {
        this.hub.wsSend(peer.ws, { type: "chat", chat_id: resolved, target: resolved, content: text, from: myName, ...rich, msgId });
      }
      return { ok: true };
    }
    return { ok: false, error: "No route" };
  }

  // ── Unified Chat Routing ──────────────────────────────────────────────

  routeChat(params: {
    chatId: string;
    content: string;
    from: string;
    source: "agent" | "channel";
    senderAgentId?: string;
    sourceUrl?: string;
  }): void {
    const { chatId, from, source, senderAgentId, sourceUrl } = params;
    let content = params.content;

    if (from && chatId) {
      const channelType = source === "channel"
        ? (this.hub.channelForChat.get(chatId)?.transport ?? (this.hub as any).inferChannelType?.(chatId))
        : "agent";
      (this.hub as any).autoRegisterContact?.(from, chatId, channelType);
    }

    if (source === "channel" && chatId && !this.hub.channelForChat.has(chatId)) {
      const channelClient = (sourceUrl ? this.hub.clients.get(sourceUrl) : undefined)
        ?? [...this.hub.clients.values()].find((c: any) => c.role === "channel" && (!sourceUrl || c.url === sourceUrl))
        ?? [...this.hub.clients.values()].find((c: any) => c.role === "channel");
      if (channelClient) this.hub.channelForChat.set(chatId, channelClient);
    }

    // 1. Strip bot/hub mention
    const botNames: string[] = [];
    const botUsername = (this.hub as any).opts?.botUsername as string | undefined;
    if (botUsername) botNames.push(botUsername);
    botNames.push(this.hub.name);
    for (const bn of botNames) {
      if (content.startsWith(`@${bn} `) || content.startsWith(`@${bn}\n`) || content === `@${bn}`) {
        content = content.slice(bn.length + 1).trim();
        break;
      }
    }

    // 2. Smart route: @agent mention OR slash command /agent
    const agentMention = content.match(/^[@/](\S+)\s*(.*)/s);
    if (agentMention) {
      const [, mentionedName, restContent] = agentMention;
      const targetAgent = this.hub.findAgent(mentionedName);
      if (targetAgent) {
        if (senderAgentId) {
          const authErr = checkAgentAuth(this.hub, senderAgentId, targetAgent.id);
          if (authErr) {
            const senderAgent = this.hub.agents.get(senderAgentId);
            if (senderAgent) this.hub.wsSend(senderAgent.ws, { type: "ack", ref: "agent_auth", status: "error", reason: authErr });
            this.hub.emit("agentDenied", { senderId: senderAgentId, targetId: targetAgent.id, reason: authErr });
            return;
          }
        }
        const deliverContent = restContent.trim() || content;
        this.hub.wsSend(targetAgent.ws, { type: "chat", chat_id: chatId, content: deliverContent, from });
        if (!this.hub.chatRoutes.has(chatId)) {
          this.hub.chatRoutes.set(chatId, targetAgent.id);
          const channelClient = this.hub.channelForChat.get(chatId) ?? (sourceUrl ? this.hub.clients.get(sourceUrl) : undefined) ?? [...this.hub.clients.values()].find((c: any) => c.role === "channel");
          if (channelClient) this.hub.channelForChat.set(chatId, channelClient);
        }
        this.hub.emit("smartRoute", { chatId, agentName: mentionedName, agentId: targetAgent.id, source });
        process.stderr.write(`[${this.hub.name}] Smart route: @${mentionedName} -> agent "${targetAgent.name}" (via ${source})\n`);
        return;
      }
      // Check persistent agents
      if ((this.hub as any)._persistentAgentRouter) {
        const routed = (this.hub as any)._persistentAgentRouter(mentionedName, restContent.trim() || content, from, chatId);
        if (routed) {
          this.hub.emit("smartRoute", { chatId, agentName: mentionedName, agentId: `persistent:${mentionedName}`, source });
          process.stderr.write(`[${this.hub.name}] Smart route: @${mentionedName} -> persistent agent "${mentionedName}" (via ${source})\n`);
          return;
        }
      }
    }

    // 3. Intent-based routing
    if (!this.hub.chatRoutes.has(chatId)) {
      const tokens = content.toLowerCase().split(/\s+/);
      let bestAgent: AgentState | undefined;
      let bestScore = 0;
      const matches: Array<{ agentId: string; agentName: string; score: number; matched: string[] }> = [];

      for (const agent of this.hub.agents.values()) {
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
        this.hub.wsSend(bestAgent.ws, { type: "chat", chat_id: chatId, content, from });
        this.hub.chatRoutes.set(chatId, bestAgent.id);
        const channelClient = this.hub.channelForChat.get(chatId) ?? [...this.hub.clients.values()].find((c: any) => c.role === "channel");
        if (channelClient) this.hub.channelForChat.set(chatId, channelClient);
        this.hub.emit("intentRoute", { chatId, agentName: bestAgent.name, agentId: bestAgent.id, source, matches, bestScore });
        process.stderr.write(`[${this.hub.name}] Intent route: "${bestAgent.name}" matched ${bestScore} keyword(s) (via ${source})\n`);
        return;
      }
    }

    // 4. Handover-owner-reply
    if (source === "agent" && senderAgentId) {
      const routeOwner = this.hub.chatRoutes.get(chatId);
      if (routeOwner === senderAgentId) {
        const channelClient = this.hub.channelForChat.get(chatId);
        if (channelClient) {
          const authError = checkChannelAuth(this.hub, senderAgentId, channelClient.transport);
          if (authError) {
            const agent = this.hub.agents.get(senderAgentId);
            if (agent) this.hub.wsSend(agent.ws, { type: "ack", ref: "channel_auth", status: "error", reason: authError });
            this.hub.emit("channelDenied", { agentId: senderAgentId, agentName: agent?.name, channel: channelClient.transport, action: "reply" });
            return;
          }
          this.hub.wsSend(channelClient.ws, { type: "chat", chat_id: chatId, content, from });
        }
        this.emitMessage(content, chatId, from);
        return;
      }
    }

    // ChatRoute dispatch
    if (this.trySendToRoute(chatId, content, from)) return;

    // Broadcast to host
    this.emitMessage(content, chatId, from);
  }

  // ── Envelope & EventRouter ────────────────────────────────────────────

  wrapEnvelope(payload: any, opts?: { to?: string; session?: string }): SessionEnvelope {
    const myName = this.resolvedName();
    const msgType = payload?.type as string | undefined;
    let envelopeType: SessionEnvelope["type"] = "system";
    if (msgType === "chat" || msgType === "reply") envelopeType = "chat";
    else if (msgType === "tool_call" || msgType === "tool_call_proxy") envelopeType = "tool_call";
    else if (msgType === "tool_result") envelopeType = "tool_result";
    else if (msgType === "invite" || msgType === "group_broadcast") envelopeType = "handover";
    return createEnvelope(myName, envelopeType, payload, opts);
  }

  route(envelope: SessionEnvelope, filter: RecipientFilter = "broadcast"): number {
    let delivered = 0;
    const sendToAgents = filter === "broadcast" || filter === "agent-only" || filter === "session-scoped";
    const sendToHost = filter === "broadcast" || filter === "host-only";

    if (sendToAgents) {
      if (filter === "session-scoped") {
        let targetAgent: { id: string; name: string; ws: any } | undefined;
        if (envelope.to) {
          targetAgent = this.hub.findAgent(envelope.to);
        } else if (envelope.session) {
          const routedId = this.hub.chatRoutes.get(envelope.session);
          if (routedId) targetAgent = this.hub.agents.get(routedId);
        }
        if (targetAgent) {
          this.hub.wsSend(targetAgent.ws, envelope.payload);
          delivered++;
        }
      } else {
        if (envelope.to) {
          const target = this.hub.findAgent(envelope.to);
          if (target) {
            this.hub.wsSend(target.ws, envelope.payload);
            delivered++;
          }
        } else {
          for (const agent of this.hub.agents.values()) {
            this.hub.wsSend(agent.ws, envelope.payload);
            delivered++;
          }
        }
      }
    }

    if (sendToHost) {
      if (envelope.to) {
        const cws = this.hub.getClientWs();
        if (cws) {
          this.hub.wsSend(cws, envelope.payload);
          delivered++;
        }
      } else {
        for (const client of this.hub.clients.values()) {
          this.hub.wsSend(client.ws, envelope.payload);
          delivered++;
        }
      }
    }

    this.hub.emit("routed", { envelope, filter, delivered });
    return delivered;
  }

  // ── Chat Handover ─────────────────────────────────────────────────────

  handover(chatId: string, toAgentId: string): { ok: boolean; error?: string } | Promise<{ ok: boolean; error?: string }> {
    if (this.hub.isClient()) {
      return (this.hub as any).proxyToServer("handover", { chatId, toAgentId });
    }
    const agent = this.hub.findAgent(toAgentId);
    if (!agent) return { ok: false, error: "Agent not found" };
    const channelClient = [...this.hub.clients.values()].find((c: any) => c.channelId === chatId || c.channelId.endsWith(`:${chatId}`));
    if (channelClient && agent.allowedChannels?.length) {
      if (!agent.allowedChannels.includes(channelClient.transport)) {
        this.hub.emit("channelDenied", { agentId: agent.id, agentName: agent.name, channel: channelClient.transport, action: "handover" });
        return { ok: false, error: `Agent "${agent.name}" not authorized for ${channelClient.transport} channel` };
      }
    }
    this.hub.chatRoutes.set(chatId, agent.id);
    (this.hub as any).persistState?.().catch(() => {});

    let matchedClient: { url: string; entry: any } | undefined;
    for (const [url, entry] of this.hub.clients) {
      if (entry.channelId === chatId || entry.channelId.endsWith(`:${chatId}`)) {
        matchedClient = { url, entry };
        break;
      }
    }
    if (matchedClient) {
      this.hub.channelForChat.set(chatId, matchedClient.entry);
    }

    const channel = matchedClient ? matchedClient.entry.transport : "unknown";
    const channelUrl = matchedClient ? matchedClient.url : `${channel}://${chatId}`;
    const channelId = matchedClient ? matchedClient.entry.channelId : `${channel}:${chatId}`;
    this.hub.wsSend(agent.ws, { type: "chat", chat_id: chatId, content: `[system] Channel handover: you now own ${channelUrl} (id: ${channelId}). Reply to messages from this channel.`, from: "system", meta: { type: "system", channel, channelId, channelUrl, handover: "true" } });
    this.hub.emit("handover", { chatId, toAgentId: agent.id, toAgentName: agent.name, channel, channelId, channelUrl });
    process.stderr.write(`[${this.hub.name}] Chat "${chatId}" handed over to agent "${agent.name}" (${agent.id})\n`);
    return { ok: true };
  }
}
