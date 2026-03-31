import type { SessionEnvelope, RecipientFilter, RichMessageParams } from "@gettalon/protocol";
import type { AgentState, TargetEntry } from "./types.js";
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
    findAgent(idOrName: string): {
        id: string;
        name: string;
        ws: any;
        allowedChannels?: string[];
        allowedAgents?: string[];
        intents?: string[];
        tools?: any[];
    } | undefined;
    wsSend(ws: any, data: any): void;
    getClientWs(): any;
    bufferMessage(key: string, content: string, from: string, rich?: RichMessageParams): void;
    emit(event: string, ...args: any[]): boolean;
}
export declare class HubRouter {
    private readonly hub;
    constructor(hub: HubRouterHost);
    registerTarget(name: string, channelType: string, rawId: string, kind: TargetEntry["kind"], sourceUrl?: string): string;
    findTarget(nameOrUuid: string): TargetEntry | undefined;
    displayName(chatId: string): string;
    resolvedName(): string;
    clearRoute(chatId: string): void;
    getChatRoute(chatId: string): string | undefined | Promise<string | undefined>;
    releaseChat(chatId: string): {
        ok: boolean;
        error?: string;
    } | Promise<{
        ok: boolean;
        error?: string;
    }>;
    emitMessage(content: string, chatId: string, user: string, extra?: Record<string, unknown>): void;
    resolveTarget(target: string): string;
    trySendToRoute(chatId: string, content: string, from: string, rich?: RichMessageParams): boolean;
    sendMessage(target: string | undefined, content: string, rich?: RichMessageParams): {
        ok: boolean;
        error?: string;
    };
    reply(chatId: string, text: string, rich?: RichMessageParams): {
        ok: boolean;
        error?: string;
    };
    routeChat(params: {
        chatId: string;
        content: string;
        from: string;
        source: "agent" | "channel";
        senderAgentId?: string;
        sourceUrl?: string;
    }): void;
    wrapEnvelope(payload: any, opts?: {
        to?: string;
        session?: string;
    }): SessionEnvelope;
    route(envelope: SessionEnvelope, filter?: RecipientFilter): number;
    handover(chatId: string, toAgentId: string): {
        ok: boolean;
        error?: string;
    } | Promise<{
        ok: boolean;
        error?: string;
    }>;
}
//# sourceMappingURL=hub-router.d.ts.map