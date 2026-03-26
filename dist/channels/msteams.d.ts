/**
 * Microsoft Teams Channel Adapter
 *
 * Uses botbuilder (Bot Framework SDK). Activity handler for inbound,
 * Adaptive Cards for messages and permission prompts.
 */
import { ChannelServer } from "../channel-server.js";
export interface TeamsConfig {
    appId: string;
    appPassword: string;
    port?: number;
}
export declare function parseConfig(): TeamsConfig;
export declare function createTeamsChannel(config?: Partial<TeamsConfig>): Promise<{
    channel: ChannelServer;
    cleanup: () => void;
}>;
//# sourceMappingURL=msteams.d.ts.map