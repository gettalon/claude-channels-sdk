export const taskStatusTool = {
    name: "task_status",
    description: "Show task board across all agents — tasks, dependencies, priorities, ownership. Filter by agent or status.",
    inputSchema: { type: "object", properties: { agent: { type: "string", description: "Filter by agent name" }, status: { type: "string", description: "Filter by status (pending, in_progress, completed)" } }, required: [] },
    handle: async (args) => {
        const { readdirSync, readFileSync } = await import("node:fs");
        const { join: joinPath } = await import("node:path");
        const { homedir } = await import("node:os");
        const agentsDir = joinPath(homedir(), ".talon", "agents");
        const filter = args.agent?.toLowerCase();
        const statusFilter = args.status?.toLowerCase();
        let results = [];
        let totalTasks = 0;
        const priorityOrder = { critical: 0, high: 1, normal: 2, low: 3 };
        try {
            const dirs = readdirSync(agentsDir).sort();
            for (const dir of dirs) {
                if (dir.startsWith(".") || dir.includes(".json"))
                    continue;
                const jsonPath = joinPath(agentsDir, dir, "agent.json");
                let data;
                try {
                    data = JSON.parse(readFileSync(jsonPath, "utf-8"));
                }
                catch {
                    continue;
                }
                if (filter && !dir.toLowerCase().includes(filter))
                    continue;
                if (!data.tasks?.length)
                    continue;
                const tasks = [...data.tasks].sort((a, b) => (priorityOrder[a.priority] ?? 2) - (priorityOrder[b.priority] ?? 2));
                results.push(`\n[${dir}] (${data.status || "unknown"})`);
                for (const t of tasks) {
                    if (statusFilter && (t.status || "pending") !== statusFilter)
                        continue;
                    totalTasks++;
                    const icon = t.status === "completed" ? "+" : t.status === "in_progress" ? ">" : "-";
                    const prio = t.priority && t.priority !== "normal" ? ` !${t.priority}` : "";
                    const blocked = t.blockedBy?.length ? ` blockedBy:[${t.blockedBy.join(",")}]` : "";
                    const blocks = t.blocks?.length ? ` blocks:[${t.blocks.join(",")}]` : "";
                    const owner = t.owner && t.owner !== dir ? ` (${t.owner})` : "";
                    results.push(`  ${icon} #${t.id} ${t.subject} [${t.status || "pending"}]${prio}${owner}${blocked}${blocks}`);
                }
            }
        }
        catch { }
        const summary = `\n---\n${totalTasks} tasks across agents`;
        return results.length ? results.join("\n") + summary : "No tasks found.";
    },
};
//# sourceMappingURL=task-status.js.map