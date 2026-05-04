declare const TABLE = "_deploy_gate_markers";
declare const LEGACY_TABLE = "_app_deploy_markers";
export interface GateConfig {
    databaseUrl: string;
    version: string;
}
export declare function markReady(cfg: GateConfig): Promise<void>;
export interface WaitOptions extends GateConfig {
    timeoutMs: number;
    pollMs?: number;
    onPoll?: (current: string | null, expected: string, elapsedMs: number) => void;
}
export declare function waitForReady(opts: WaitOptions): Promise<void>;
export declare function getTenantCount(databaseUrl: string): Promise<number>;
export interface ComputeTimeoutOptions {
    tenantCount: number;
    perTenantMs?: number;
    baseMs?: number;
    ceilingMs?: number;
}
export declare function computeTimeoutMs(opts: ComputeTimeoutOptions): number;
export { LEGACY_TABLE, TABLE };
//# sourceMappingURL=lib.d.ts.map