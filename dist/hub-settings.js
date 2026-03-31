/**
 * hub-settings.ts — Settings lock, load, save, merge, state persistence.
 * Extracted from hub.ts (lines 126–169, 1432–1563).
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
// ── Settings path & lock state ────────────────────────────────────────────
function resolveTalonHome() { return process.env.TALON_HOME ?? join(homedir(), ".talon"); }
/** Explicit override; when null, path is derived dynamically from TALON_HOME / homedir. */
let SETTINGS_PATH_OVERRIDE = null;
let lockHeld = false;
let settingsHash = "";
function resolveSettingsPath() { return SETTINGS_PATH_OVERRIDE ?? join(resolveTalonHome(), "settings.json"); }
function getLockPath() { return resolveSettingsPath() + ".lock"; }
function getBackupPath() { return resolveSettingsPath() + ".bak"; }
/** The resolved Talon home directory (TALON_HOME env or ~/.talon) */
export function getTalonHome() { return resolveTalonHome(); }
/** Set custom settings path (for testing) */
export function setSettingsPath(path) { SETTINGS_PATH_OVERRIDE = path; }
export function getSettingsPath() { return resolveSettingsPath(); }
export async function acquireLock(timeout = 5000) {
    const { open } = await import("node:fs/promises");
    const LOCK_PATH = getLockPath();
    const start = Date.now();
    while (Date.now() - start < timeout) {
        try {
            const fd = await open(LOCK_PATH, "wx");
            await fd.close();
            lockHeld = true;
            return;
        }
        catch (e) {
            if (e.code === "EEXIST") {
                try {
                    const { stat } = await import("node:fs/promises");
                    const s = await stat(LOCK_PATH);
                    if (Date.now() - s.mtimeMs > 10000) {
                        await import("node:fs/promises").then(f => f.unlink(LOCK_PATH)).catch(() => { });
                        continue;
                    }
                }
                catch { }
                await new Promise(r => setTimeout(r, 50));
            }
            else
                throw e;
        }
    }
    throw new Error("Settings lock timeout");
}
export async function releaseLock() {
    if (lockHeld) {
        await import("node:fs/promises").then(f => f.unlink(getLockPath())).catch(() => { });
        lockHeld = false;
    }
}
// ── Settings load/save ────────────────────────────────────────────────────
export async function loadSettings() {
    try {
        const raw = await readFile(resolveSettingsPath(), "utf-8");
        settingsHash = raw;
        return JSON.parse(raw);
    }
    catch {
        return {};
    }
}
export async function loadSettingsSafe() {
    try {
        const raw = await readFile(resolveSettingsPath(), "utf-8");
        settingsHash = raw;
        return JSON.parse(raw);
    }
    catch {
        try {
            const raw = await readFile(getBackupPath(), "utf-8");
            const parsed = JSON.parse(raw);
            await writeFile(resolveSettingsPath(), raw);
            settingsHash = raw;
            return parsed;
        }
        catch {
            return {};
        }
    }
}
export async function saveSettings(settings) {
    const settingsPath = resolveSettingsPath();
    await mkdir(dirname(settingsPath), { recursive: true });
    await acquireLock();
    try {
        // Read-merge-write: never overwrite, always merge
        let existing = {};
        try {
            existing = JSON.parse(await readFile(settingsPath, "utf-8"));
        }
        catch { }
        const merged = { ...existing, ...settings };
        // Deep merge key sections to prevent data loss
        if (existing.transports || settings.transports)
            merged.transports = { ...(existing.transports ?? {}), ...(settings.transports ?? {}) };
        if (existing.access || settings.access)
            merged.access = { ...(existing.access ?? {}), ...(settings.access ?? {}) };
        if (existing.state || settings.state)
            merged.state = { ...(existing.state ?? {}), ...(settings.state ?? {}) };
        if (existing.contacts || settings.contacts)
            merged.contacts = { ...(existing.contacts ?? {}), ...(settings.contacts ?? {}) };
        const json = JSON.stringify(merged, null, 2);
        JSON.parse(json); // validate
        try {
            await readFile(settingsPath, "utf-8").then(d => writeFile(getBackupPath(), d));
        }
        catch { }
        await writeFile(settingsPath, json);
        settingsHash = json;
    }
    finally {
        await releaseLock();
    }
}
// ── Server/Connection registry ────────────────────────────────────────────
export async function registerServer(url, name, port) {
    const settings = await loadSettings();
    settings.servers = settings.servers ?? [];
    settings.servers = settings.servers.filter((s) => s.port !== port);
    settings.servers.push({ url, name, port, pid: process.pid, startedAt: new Date().toISOString() });
    await saveSettings(settings);
}
export async function unregisterServer(port) {
    const settings = await loadSettings();
    settings.servers = (settings.servers ?? []).filter((s) => s.port !== port);
    await saveSettings(settings);
}
export async function getRegisteredServers() {
    return (await loadSettings()).servers ?? [];
}
export async function addConnection(url, name, config) {
    const settings = await loadSettings();
    settings.connections = settings.connections ?? [];
    // Replace existing or add new (no duplicates)
    settings.connections = settings.connections.filter((c) => c.url !== url);
    const entry = { url, name, connectedAt: new Date().toISOString() };
    if (config)
        entry.config = config;
    settings.connections.push(entry);
    await saveSettings(settings);
}
export async function removeConnection(url) {
    const settings = await loadSettings();
    settings.connections = (settings.connections ?? []).filter((c) => c.url !== url);
    await saveSettings(settings);
}
export async function getConnections() {
    return (await loadSettings()).connections ?? [];
}
// ── State persistence ─────────────────────────────────────────────────────
/** Install settings + state persistence methods onto ChannelHub prototype. */
export function installSettings(Hub) {
    Hub.prototype.loadSettings = function () {
        return loadSettings();
    };
    Hub.prototype.loadSettingsSafe = function () {
        return loadSettingsSafe();
    };
    Hub.prototype.saveSettings = function (settings) {
        return saveSettings(settings);
    };
    Hub.prototype.registerServer = function (url, name, port) {
        return registerServer(url, name, port);
    };
    Hub.prototype.unregisterServer = function (port) {
        return unregisterServer(port);
    };
    Hub.prototype.getRegisteredServers = function () {
        return getRegisteredServers();
    };
    Hub.prototype.addConnection = function (url, name, config) {
        return addConnection(url, name, config);
    };
    Hub.prototype.removeConnection = function (url) {
        return removeConnection(url);
    };
    Hub.prototype.getConnections = function () {
        return getConnections();
    };
    Hub.prototype.persistState = async function () {
        const newState = {
            chatRoutes: Object.fromEntries([...this.chatRoutes.entries()].map(([chatId, agentId]) => {
                const agent = this.agents.get(agentId);
                const channel = this.channelForChat.get(chatId);
                return [chatId, { agentName: agent?.name ?? "unknown", channel: channel?.transport, channelUrl: channel?.url }];
            })),
            groups: Object.fromEntries([...this.groups.entries()].map(([name, memberMap]) => [name, [...memberMap.values()].map(m => m.mode === "all" ? m.name : `${m.name}|${m.mode}`)])),
            targets: Object.fromEntries([...this.targetRegistry.entries()].map(([uuid, entry]) => [uuid, { name: entry.name, channelType: entry.channelType, rawId: entry.rawId, kind: entry.kind, ...(entry.sourceUrl ? { sourceUrl: entry.sourceUrl } : {}) }])),
        };
        const json = JSON.stringify(newState);
        if (json === this.lastPersistedStateJson)
            return;
        this.lastPersistedStateJson = json;
        const settings = await loadSettings();
        settings.state = newState;
        await saveSettings(settings);
        // Also persist per-agent configs
        for (const agentId of this.agents.keys()) {
            this.persistAgentConfig(agentId).catch(() => { });
        }
    };
    Hub.prototype.restoreState = async function () {
        const settings = await loadSettings();
        if (settings.state?.chatRoutes) {
            for (const [chatId, info] of Object.entries(settings.state.chatRoutes)) {
                // Find agent by name (ID changes across restarts)
                const agent = this.findAgent(info.agentName);
                if (agent) {
                    this.chatRoutes.set(chatId, agent.id);
                    process.stderr.write(`[${this.name}] Restored route: ${chatId} → ${agent.name}\n`);
                }
            }
        }
        if (settings.state?.groups) {
            for (const [name, memberEntries] of Object.entries(settings.state.groups)) {
                if (!memberEntries.length)
                    continue;
                const memberMap = new Map();
                for (const entry of memberEntries) {
                    // Entries are either "name" (mode=all) or "name|@only"
                    const pipeIdx = entry.indexOf("|");
                    if (pipeIdx === -1) {
                        memberMap.set(entry, { name: entry, mode: "all" });
                    }
                    else {
                        const mName = entry.slice(0, pipeIdx);
                        const mMode = entry.slice(pipeIdx + 1);
                        memberMap.set(mName, { name: mName, mode: mMode });
                    }
                }
                this.groups.set(name, memberMap);
            }
        }
        if (settings.state?.targets) {
            for (const [uuid, entry] of Object.entries(settings.state.targets)) {
                if (this.registerTarget) {
                    this.registerTarget(entry.name, entry.channelType, entry.rawId, entry.kind, entry.sourceUrl);
                }
            }
            const count = Object.keys(settings.state.targets).length;
            if (count)
                process.stderr.write(`[${this.name}] Restored ${count} target(s) from settings\n`);
        }
    };
}
//# sourceMappingURL=hub-settings.js.map