/**
 * Per-agent configuration — load, save, list, delete, migrate.
 *
 * Each agent gets its own config file at ~/.talon/agents/{id}.json.
 * This isolates per-agent state (access, contacts, chatRoutes, handover)
 * from global settings (servers, transports, hooks, mesh).
 */
import { readFile, writeFile, mkdir, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { getTalonHome } from "./hub-settings.js";
function getDefaultAgentsDir() { return join(getTalonHome(), "agents"); }
/**
 * Load a single agent config by ID.
 * Returns null if the file does not exist or is corrupt.
 */
export async function loadAgentConfig(id, agentsDir = getDefaultAgentsDir()) {
    try {
        const raw = await readFile(join(agentsDir, `${id}.json`), "utf-8");
        return JSON.parse(raw);
    }
    catch {
        return null;
    }
}
/**
 * Save (create or overwrite) an agent config.
 * Sets updatedAt to now; sets createdAt if not already present.
 * Creates the agents directory if it does not exist.
 */
export async function saveAgentConfig(config, agentsDir = getDefaultAgentsDir()) {
    await mkdir(agentsDir, { recursive: true });
    config.updatedAt = new Date().toISOString();
    if (!config.createdAt)
        config.createdAt = config.updatedAt;
    await writeFile(join(agentsDir, `${config.id}.json`), JSON.stringify(config, null, 2));
}
/**
 * List all agent configs in the agents directory.
 * Skips non-JSON files and corrupt files.
 * Returns an empty array if the directory does not exist.
 */
export async function listAgentConfigs(agentsDir = getDefaultAgentsDir()) {
    try {
        const files = await readdir(agentsDir);
        const configs = [];
        for (const f of files) {
            if (!f.endsWith(".json"))
                continue;
            try {
                const raw = await readFile(join(agentsDir, f), "utf-8");
                configs.push(JSON.parse(raw));
            }
            catch {
                /* skip corrupt files */
            }
        }
        return configs;
    }
    catch {
        return [];
    }
}
/**
 * Delete an agent config file. No-op if the file does not exist.
 */
export async function deleteAgentConfig(id, agentsDir = getDefaultAgentsDir()) {
    try {
        await unlink(join(agentsDir, `${id}.json`));
    }
    catch {
        /* file may not exist — that's fine */
    }
}
/**
 * Migrate a flat settings.json into global settings + per-agent configs.
 *
 * Global keeps: servers, connections, transports, hooks, mesh
 * Per-agent gets: access, state, contacts, handover
 *
 * Returns { global, agents } — does NOT modify any files (caller decides).
 */
export async function migrateSettingsToPerAgent(talonDir) {
    const settingsPath = join(talonDir, "settings.json");
    let settings;
    try {
        settings = JSON.parse(await readFile(settingsPath, "utf-8"));
    }
    catch {
        return { global: {}, agents: [] };
    }
    // Split: global keeps infrastructure keys
    const globalKeys = ["servers", "connections", "transports", "hooks", "mesh"];
    const global = {};
    for (const k of globalKeys) {
        if (k in settings)
            global[k] = settings[k];
    }
    // Per-agent keys become a default migrated agent
    const agentKeys = ["access", "state", "contacts", "handover"];
    const hasAgentData = agentKeys.some((k) => k in settings);
    const agents = [];
    if (hasAgentData) {
        const defaultAgent = {
            id: "migrated-default",
            name: "default",
            createdAt: new Date().toISOString(),
        };
        for (const k of agentKeys) {
            if (k in settings)
                defaultAgent[k] = settings[k];
        }
        agents.push(defaultAgent);
    }
    return { global, agents };
}
//# sourceMappingURL=agent-config.js.map