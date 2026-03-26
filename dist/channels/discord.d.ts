/**
 * Discord Channel Adapter
 *
 * Uses discord.js Client. Message events for inbound, markdown support (2000 char limit),
 * button components for permission prompts, extra tools: discord_react, discord_thread, discord_edit.
 */
import { ChannelServer } from "../channel-server.js";
export interface DiscordConfig {
    token: string;
    allowedChannels?: string[];
}
export declare function parseConfig(): DiscordConfig;
export declare function createDiscordChannel(config?: Partial<DiscordConfig>): Promise<{
    channel: ChannelServer;
    cleanup: () => void;
}>;
//# sourceMappingURL=discord.d.ts.map