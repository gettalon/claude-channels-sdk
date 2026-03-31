import type { AgentConfig } from "./types.js";
/**
 * Load a single agent config by ID.
 * Returns null if the file does not exist or is corrupt.
 */
export declare function loadAgentConfig(id: string, agentsDir?: string): Promise<AgentConfig | null>;
/**
 * Save (create or overwrite) an agent config.
 * Sets updatedAt to now; sets createdAt if not already present.
 * Creates the agents directory if it does not exist.
 */
export declare function saveAgentConfig(config: AgentConfig, agentsDir?: string): Promise<void>;
/**
 * List all agent configs in the agents directory.
 * Skips non-JSON files and corrupt files.
 * Returns an empty array if the directory does not exist.
 */
export declare function listAgentConfigs(agentsDir?: string): Promise<AgentConfig[]>;
/**
 * Delete an agent config file. No-op if the file does not exist.
 */
export declare function deleteAgentConfig(id: string, agentsDir?: string): Promise<void>;
/**
 * Migrate a flat settings.json into global settings + per-agent configs.
 *
 * Global keeps: servers, connections, transports, hooks, mesh
 * Per-agent gets: access, state, contacts, handover
 *
 * Returns { global, agents } — does NOT modify any files (caller decides).
 */
export declare function migrateSettingsToPerAgent(talonDir: string): Promise<{
    global: Record<string, unknown>;
    agents: AgentConfig[];
}>;
//# sourceMappingURL=agent-config.d.ts.map