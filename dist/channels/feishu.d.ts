/**
 * Feishu / Lark Channel Adapter
 *
 * Uses @larksuiteoapi/node-sdk. Event subscription for inbound,
 * rich text messages, interactive card buttons for permission prompts.
 */
import { ChannelServer } from "../channel-server.js";
export interface FeishuConfig {
    appId: string;
    appSecret: string;
}
export declare function parseConfig(): FeishuConfig;
export declare function createFeishuChannel(config?: Partial<FeishuConfig>): Promise<{
    channel: ChannelServer;
    cleanup: () => void;
}>;
//# sourceMappingURL=feishu.d.ts.map