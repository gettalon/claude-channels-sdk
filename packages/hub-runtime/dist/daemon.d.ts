export interface DaemonStatus {
    running: boolean;
    pid: number | null;
    pidFile: string;
    logFile: string;
}
export declare function daemonStatus(): Promise<DaemonStatus>;
export declare function daemonStop(): Promise<{
    stopped: boolean;
    pid: number | null;
    error?: string;
}>;
export interface DaemonStartResult {
    started: boolean;
    pid: number | null;
    pidFile: string;
    logFile: string;
    error?: string;
}
export declare function daemonStart(opts?: {
    port?: number;
}): Promise<DaemonStartResult>;
export declare function daemonRestart(opts?: {
    port?: number;
}): Promise<DaemonStartResult>;
export declare function daemonEnable(): Promise<{
    enabled: boolean;
    path: string;
    error?: string;
}>;
export declare function daemonDisable(): Promise<{
    disabled: boolean;
    error?: string;
}>;
//# sourceMappingURL=daemon.d.ts.map