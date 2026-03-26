/**
 * IRC Channel Adapter
 *
 * Uses irc-framework. PRIVMSG for inbound, plain text with 512 byte line limit,
 * text-based permission prompts (reply YES/NO).
 */
import { ChannelServer } from "../channel-server.js";
export interface IrcConfig {
    server: string;
    port: number;
    nick: string;
    channels: string[];
    password?: string;
    tls?: boolean;
}
export declare function parseConfig(): IrcConfig;
export declare function createIrcChannel(config?: Partial<IrcConfig>): Promise<{
    channel: ChannelServer;
    cleanup: () => void;
}>;
//# sourceMappingURL=irc.d.ts.map