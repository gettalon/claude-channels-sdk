/**
 * Matrix Channel Adapter
 *
 * Uses matrix-js-sdk. Room timeline events for inbound, HTML formatted messages
 * with chunking, reaction emoji permission prompts, extra tools: matrix_react, matrix_room.
 */
import { ChannelServer } from "../channel-server.js";
export interface MatrixConfig {
    homeserver: string;
    accessToken: string;
    userId: string;
}
export declare function parseConfig(): MatrixConfig;
export declare function createMatrixChannel(config?: Partial<MatrixConfig>): Promise<{
    channel: ChannelServer;
    cleanup: () => void;
}>;
//# sourceMappingURL=matrix.d.ts.map