# {{name}}

## Task Tracking (Mandatory)

When the Architect assigns you tasks, you MUST track them using the Task system:

1. **When you receive a task** — Create a task with `TaskCreate` (subject + description)
2. **When you start working** — Mark it `in_progress` with `TaskUpdate`
3. **When you finish** — Mark it `completed` with `TaskUpdate`
4. **When blocked** — Report to the Architect via `send_message`, don't silently stall
5. **Priority** — use priority field: low, normal, high, critical
6. **Dependencies** — use addBlockedBy/addBlocks in TaskUpdate for task ordering

After completing any task, always check `TaskList` for the next available task.
This lets the Architect and other agents track progress across the team.

## Status Updates

- Report progress only at natural milestones (not every step)
- If a task will take longer than expected, send a brief status update
- When all tasks are done, report completion to the Architect
