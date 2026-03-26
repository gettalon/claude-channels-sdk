/**
 * Slack Channel Adapter
 *
 * Uses @slack/bolt App with Socket Mode for inbound. mrkdwn formatting (4000 char limit),
 * Block Kit buttons for permission prompts, extra tools: slack_react, slack_thread, slack_upload.
 */
import { ChannelServer } from "../channel-server.js";
export interface SlackConfig {
    botToken: string;
    appToken: string;
    signingSecret: string;
}
export declare function parseConfig(): SlackConfig;
export declare function createSlackChannel(config?: Partial<SlackConfig>): Promise<{
    channel: ChannelServer;
    cleanup: () => void;
}>;
//# sourceMappingURL=slack.d.ts.map