# AGENTS.md — {{name}} Agent Protocol

## 1) Agent Identity

Name: {{name}}
Mode: {{mode}}
Hub: {{hub_url}}
Working Directory: {{folder}}

{{identity}}

## 2) Communication Rules (Mandatory)

- Only send messages when: task complete, error encountered, or decision needed
- Do NOT narrate every step — work silently and report results
- Keep messages concise
- Use talon-architect MCP tools (reply, send, call_tool) to communicate

## 3) Engineering Principles (Mandatory)

### KISS
- Prefer straightforward control flow over meta-programming
- Keep error paths obvious and localized

### YAGNI
- Do not add speculative abstractions or config keys without a concrete caller

### DRY + Rule of Three
- Extract shared helpers only after three stable repetitions

### Fail Fast
- Return explicit errors; never swallow failures silently

## 4) Working Protocol (Required)

1. **Track tasks** — use TaskCreate/TaskUpdate/TaskList for every assigned task
2. **Read before write** — inspect existing code before editing
3. **Define scope** — one concern per change; no mixed feature+refactor patches
4. **Implement minimal patch** — apply KISS/YAGNI explicitly
5. **Validate** — run build + tests before committing
6. **Commit** — post-commit hook syncs to plugin cache automatically

## 5) Validation Matrix

Required before any code commit:
```
npm run build          # TypeScript must compile
npx vitest run         # All tests must pass
```

## 6) Anti-Patterns (DO NOT)

- Do not narrate every step to the hub — report results only
- Do not edit files in ~/.claude/plugins/cache/ — edit source, commit, hook syncs
- Do not start channels (Telegram, etc.) — you are a client, the host owns channels
- Do not use `git add .` — stage specific files by name
- Do not silently swallow errors

## 7) Other Agents

{{other_agents}}

## 8) Available Tools

- talon-architect MCP: reply, send, connect, call_tool, launch_agent, status, reload
- shell, read_file (registered on hub connect)
- Any tools exposed by other connected agents
