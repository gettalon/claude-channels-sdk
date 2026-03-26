/**
 * Signal Channel Adapter
 *
 * Uses signal-cli REST API (HTTP client). Polling /v1/receive for inbound,
 * POST /v2/send for outbound, text-based permission prompts with reply.
 */
import { ChannelServer } from "../channel-server.js";
export interface SignalConfig {
    cliUrl: string;
    phoneNumber: string;
}
export declare function parseConfig(): SignalConfig;
export declare function createSignalChannel(config?: Partial<SignalConfig>): Promise<{
    channel: ChannelServer;
    cleanup: () => void;
}>;
//# sourceMappingURL=signal.d.ts.map