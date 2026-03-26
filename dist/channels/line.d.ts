/**
 * LINE Channel Adapter
 *
 * Uses @line/bot-sdk. Webhook for inbound messages, Flex Message support,
 * quick reply buttons for permission prompts.
 */
import { ChannelServer } from "../channel-server.js";
export interface LineConfig {
    channelAccessToken: string;
    channelSecret: string;
    webhookPort: number;
}
export declare function parseConfig(): LineConfig;
export declare function createLineChannel(config?: Partial<LineConfig>): Promise<{
    channel: ChannelServer;
    cleanup: () => void;
}>;
//# sourceMappingURL=line.d.ts.map