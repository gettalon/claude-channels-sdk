import type { HubSettings } from "./hub.js";
import type { ChannelHub } from "./hub.js";
/** The resolved Talon home directory (TALON_HOME env or ~/.talon) */
export declare function getTalonHome(): string;
/** Set custom settings path (for testing) */
export declare function setSettingsPath(path: string): void;
export declare function getSettingsPath(): string;
export declare function acquireLock(timeout?: number): Promise<void>;
export declare function releaseLock(): Promise<void>;
export declare function loadSettings(): Promise<HubSettings>;
export declare function loadSettingsSafe(): Promise<HubSettings>;
export declare function saveSettings(settings: HubSettings): Promise<void>;
export declare function registerServer(url: string, name: string, port: number): Promise<void>;
export declare function unregisterServer(port: number): Promise<void>;
export declare function getRegisteredServers(): Promise<HubSettings["servers"]>;
export declare function addConnection(url: string, name: string, config?: Record<string, unknown>): Promise<void>;
export declare function removeConnection(url: string): Promise<void>;
export declare function getConnections(): Promise<HubSettings["connections"]>;
/** Install settings + state persistence methods onto ChannelHub prototype. */
export declare function installSettings(Hub: typeof ChannelHub): void;
//# sourceMappingURL=hub-settings.d.ts.map