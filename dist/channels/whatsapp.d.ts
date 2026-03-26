/**
 * WhatsApp Channel Adapter
 *
 * Uses @whiskeysockets/baileys for WhatsApp Web multi-device.
 * QR code auth, message upsert for inbound, plain text (no markdown), 4096 char limit,
 * text-based permission prompts with reply buttons.
 */
import { ChannelServer } from "../channel-server.js";
export interface WhatsAppConfig {
    sessionPath: string;
}
export declare function parseConfig(): WhatsAppConfig;
export declare function createWhatsAppChannel(config?: Partial<WhatsAppConfig>): Promise<{
    channel: ChannelServer;
    cleanup: () => void;
}>;
//# sourceMappingURL=whatsapp.d.ts.map