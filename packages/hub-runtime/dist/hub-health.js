/** Install health monitor methods onto the hub class prototype. */
export function installHealth(Hub) {
    /** Return a point-in-time health snapshot (no side effects). */
    Hub.prototype.getHealth = async function () {
        const serverResults = [];
        for (const [id, s] of this.servers) {
            let healthy = false;
            if (s.port) {
                try {
                    const res = await fetch(`http://localhost:${s.port}/health`);
                    healthy = res.ok;
                }
                catch { /* unreachable */ }
            }
            serverResults.push({ id, healthy, port: s.port });
        }
        const clientResults = [];
        for (const [url, c] of this.clients) {
            const ws = c.ws;
            const healthy = ws && (ws.readyState === 1 || ws.readyState === undefined);
            clientResults.push({ url, healthy: !!healthy, channel: c.transport });
        }
        const now = Date.now();
        let stale = 0;
        for (const a of this.agents.values()) {
            if (now - a.lastHeartbeat > 90000)
                stale++;
        }
        return {
            servers: serverResults,
            clients: clientResults,
            agents: { total: this.agents.size, stale },
            uptime: now - this.startedAt,
        };
    };
    /**
     * Start a continuous health monitor that periodically checks servers,
     * clients, and agents — auto-reconnecting dead clients and pruning
     * stale agents. Emits "healthCheck" with the snapshot on each cycle.
     */
    Hub.prototype.startHealthMonitor = function (intervalMs = 30000) {
        if (this.healthMonitorTimer)
            return; // already running
        const runCheck = async () => {
            try {
                // 1. Check servers
                const snapshot = await this.getHealth();
                // 2. Reconnect dead clients (skip server-role to prevent hub-to-hub reconnect loops)
                for (const cr of snapshot.clients) {
                    if (!cr.healthy) {
                        const client = this.clients.get(cr.url);
                        if (client) {
                            // Skip auto-reconnect for server-role connections (hub-to-hub links)
                            // These are managed explicitly via the connect tool, not by health monitor
                            if (client.role === "server") {
                                process.stderr.write(`[${this.name}] Health: client ${cr.url} is dead (server role, cleaning up)\n`);
                                try {
                                    client.ws.close();
                                }
                                catch { }
                                this.clients.delete(cr.url);
                                continue;
                            }
                            process.stderr.write(`[${this.name}] Health: client ${cr.url} is dead, attempting reconnect\n`);
                            if (client.heartbeatTimer) {
                                clearInterval(client.heartbeatTimer);
                                client.heartbeatTimer = undefined;
                            }
                            try {
                                client.ws.close();
                            }
                            catch { }
                            this.clients.delete(cr.url);
                            try {
                                await this.connect(cr.url, client.name);
                            }
                            catch (e) {
                                process.stderr.write(`[${this.name}] Health: reconnect ${cr.url} failed: ${e}\n`);
                            }
                        }
                    }
                }
                // 3. Prune stale agents (>90 s since last heartbeat)
                const now = Date.now();
                for (const [id, a] of this.agents) {
                    if (now - a.lastHeartbeat > 90000) {
                        process.stderr.write(`[${this.name}] Health: pruning stale agent "${a.name}" (${id})\n`);
                        try {
                            a.ws.close();
                        }
                        catch { }
                        this.agents.delete(id);
                        this.emit("agentDisconnected", { id, name: a.name });
                    }
                }
                // Refresh snapshot after remediation
                const updated = await this.getHealth();
                this.emit("healthCheck", updated);
            }
            catch (e) {
                process.stderr.write(`[${this.name}] Health monitor error: ${e}\n`);
            }
        };
        this.healthMonitorTimer = setInterval(runCheck, intervalMs);
        // Run the first check immediately
        runCheck();
    };
    /** Stop the health monitor if running. */
    Hub.prototype.stopHealthMonitor = function () {
        if (this.healthMonitorTimer) {
            clearInterval(this.healthMonitorTimer);
            this.healthMonitorTimer = null;
        }
    };
}
//# sourceMappingURL=hub-health.js.map