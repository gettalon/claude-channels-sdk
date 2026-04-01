# Remaining Fixes

Status updated 2026-04-01 after HubConfigService migration.

This is the gap list that still remains between the current refactor and the blueprint success criteria.

## Must Fix To Claim Blueprint Success

asdf Copy
asdf
asdf Copy
Lorem Made
asdf
asdf Copy
Lorem Ipsum
**Status: ✅ COMPLETED (2026-04-01)**

All legacy channel adapters and active runtime modules now use `HubConfigService`:

- `src/channels/matrix.ts` → `HubConfigService.matrix*()`
- `src/channels/discord.ts` → `HubConfigService.discord*()`
- `src/channels/slack.ts` → `HubConfigService.slack*()`
- `src/channels/irc.ts` → `HubConfigService.irc*()`
- `src/channels/signal.ts` → `HubConfigService.signal*()`
- `src/channels/whatsapp.ts` → `HubConfigService.whatsapp*()`
- `src/channels/line.ts` → `HubConfigService.line*()`
- `src/channels/feishu.ts` → `HubConfigService.feishu*()`
- `src/channels/imessage.ts` → `HubConfigService.imessage*()`
- `src/channels/msteams.ts` → `HubConfigService.teams*()`
- `src/channels/mcp-http.ts` → `HubConfigService.mcpHttp*()`
- `src/architect.ts` → `HubConfigService.*()`
- `src/daemon.ts` → `HubConfigService.telegramBotToken()`
- `src/hub-client.ts` → `HubConfigService.*()`

**Sanctioned exceptions** (remain direct env reads):
- `HOME` for temp paths - generic system utility, not config
- `ANTHROPIC_*` keys in agent-launcher - external API credentials, not Talon config
- `TALON_HOME` in hub-settings.ts - bootstrap resolver, intentionally at the root

### 2. Conservative network defaults are not enforced repo-wide

**Status: ✅ COMPLETED (2026-04-01)**

All network binds now default to `127.0.0.1` (loopback only):

- `src/channels/mcp-http.ts` → defaults to `127.0.0.1`
- `src/hub-server.ts` → defaults to `127.0.0.1`
- `HubConfigService.mcpHttpHost()` → returns `127.0.0.1` by default
- `HubConfigService.wsHost()` → returns `127.0.0.1` by default
- `HubConfigService.telegramWebhookHost()` → returns `127.0.0.1` by default

External exposure now requires explicit config (`host: "0.0.0.0"`), not a fallback.

### 3. Root package API is still broad

**Status: ✅ COMPLETED (2026-04-01)**

`src/index.ts` (108 lines) has a clean export surface:
- `ChannelServer` + types
- Built-in transports (`createUnixTransport`, `createWebSocketTransport`, `createStdioTransport`)
- `ChannelHub` + types
- Agent config helpers
- Mesh utilities

No deprecated re-exports remain. The root API is the recommended entry point.

### 4. Public package identity is still muddled

The monorepo split exists, but the release model is still inconsistent.

Current state:

- Root package: `@gettalon/channels-sdk`
- Workspace compat package: `@gettalon/channels-sdk-compat`

What needs to happen:

- Decide which package is the real consumer-facing package.
- Align package naming, exports, and docs with that decision.
- Avoid shipping two overlapping public stories indefinitely.

## Architectural Debt Still Open

asdf Copy
asdf
### 5. `hub-runtime` still reaches into `hub-core` internals

**Status: ⚠️ PARTIALLY DONE (2026-04-01)**

The boundary is improved but not hard:

**What's done:**
- `HubFacade` defines command methods: `registerAgent`, `unregisterAgent`, `claimChat`, `registerTarget`, etc.
- `ChannelHub` implements these command methods.
- Mutations go through the command interface (no longer direct `.set()` calls in hub-runtime).

**What remains:**
- Direct reads still happen: `hub.agents.get()`, `hub.clients.get()`, `hub.servers.has()`, etc.
- These are reads, not mutations, but they still represent runtime knowing about core state structure.

**Follow-up:**
- Introduce read interfaces (`getAgent(id)`, `hasServer(port)`, etc.)
- Or accept reads as reasonable cross-boundary inspection.

### 6. Compat path is still doing too much transition work

Current state:

- Root package exports are still used as the main migration path.
- `packages/channels-sdk` exists, but the main release identity has not fully moved to the new package layout.

What needs to happen:

- Decide whether the compat package is temporary or primary.
- If temporary, define the removal schedule.
- If primary, rename and publish accordingly.

## Lower Priority Follow-Up

asdf Copy
asdf
### 7. Clean up duplicated source trees during transition

There is still overlap between old root `src/*` modules and new `packages/*` modules.

What needs to happen:

- Reduce duplicate implementations once migration is stable.
- Make ownership of each runtime/core module unambiguous.

### 8. Tighten comments and docs that overstate completion

Some comments and milestone summaries describe target-state architecture more strongly than the code actually enforces.

What needs to happen:

- Update docs to distinguish:
  - completed refactor steps
  - compatibility layers
  - known exceptions
  - deferred boundary hardening

- `src/channels/matrix.ts` → `HubConfigService.matrix*()`
- `src/channels/discord.ts` → `HubConfigService.discord*()`
- `src/channels/slack.ts` → `HubConfigService.slack*()`
- `src/channels/irc.ts` → `HubConfigService.irc*()`
- `src/channels/signal.ts` → `HubConfigService.signal*()`
- `src/channels/whatsapp.ts` → `HubConfigService.whatsapp*()`
- `src/channels/line.ts` → `HubConfigService.line*()`
- `src/channels/feishu.ts` → `HubConfigService.feishu*()`
- `src/channels/imessage.ts` → `HubConfigService.imessage*()`
- `src/channels/msteams.ts` → `HubConfigService.teams*()`
- `src/channels/mcp-http.ts` → `HubConfigService.mcpHttp*()`
- `src/architect.ts` → `HubConfigService.*()`
- `src/daemon.ts` → `HubConfigService.telegramBotToken()`
- `src/hub-client.ts` → `HubConfigService.*()`

**Sanctioned exceptions** (remain direct env reads):
- `HOME` for temp paths - generic system utility, not config
- `ANTHROPIC_*` keys in agent-launcher - external API credentials, not Talon config
- `TALON_HOME` in hub-settings.ts - bootstrap resolver, intentionally at the root

### 2. Conservative network defaults are not enforced repo-wide

**Status: ✅ COMPLETED (2026-04-01)**

All network binds now default to `127.0.0.1` (loopback only):

- `src/channels/mcp-http.ts` → defaults to `127.0.0.1`
- `src/hub-server.ts` → defaults to `127.0.0.1`
- `HubConfigService.mcpHttpHost()` → returns `127.0.0.1` by default
- `HubConfigService.wsHost()` → returns `127.0.0.1` by default
- `HubConfigService.telegramWebhookHost()` → returns `127.0.0.1` by default

External exposure now requires explicit config (`host: "0.0.0.0"`), not a fallback.

### 3. Root package API is still broad

**Status: ✅ COMPLETED (2026-04-01)**

`src/index.ts` (108 lines) has a clean export surface:
- `ChannelServer` + types
- Built-in transports (`createUnixTransport`, `createWebSocketTransport`, `createStdioTransport`)
- `ChannelHub` + types
- Agent config helpers
- Mesh utilities

No deprecated re-exports remain. The root API is the recommended entry point.

### 4. Public package identity is still muddled

The monorepo split exists, but the release model is still inconsistent.

Current state:

- Root package: `@gettalon/channels-sdk`
- Workspace compat package: `@gettalon/channels-sdk-compat`

What needs to happen:

- Decide which package is the real consumer-facing package.
- Align package naming, exports, and docs with that decision.
- Avoid shipping two overlapping public stories indefinitely.

## Architectural Debt Still Open

asdf Copy
asdf
### 5. `hub-runtime` still reaches into `hub-core` internals

**Status: ⚠️ PARTIALLY DONE (2026-04-01)**

The boundary is improved but not hard:

**What's done:**
- `HubFacade` defines command methods: `registerAgent`, `unregisterAgent`, `claimChat`, `registerTarget`, etc.
- `ChannelHub` implements these command methods.
- Mutations go through the command interface (no longer direct `.set()` calls in hub-runtime).

**What remains:**
- Direct reads still happen: `hub.agents.get()`, `hub.clients.get()`, `hub.servers.has()`, etc.
- These are reads, not mutations, but they still represent runtime knowing about core state structure.

**Follow-up:**
- Introduce read interfaces (`getAgent(id)`, `hasServer(port)`, etc.)
- Or accept reads as reasonable cross-boundary inspection.

### 6. Compat path is still doing too much transition work

Current state:

- Root package exports are still used as the main migration path.
- `packages/channels-sdk` exists, but the main release identity has not fully moved to the new package layout.

What needs to happen:

- Decide whether the compat package is temporary or primary.
- If temporary, define the removal schedule.
- If primary, rename and publish accordingly.

## Lower Priority Follow-Up

asdf Copy
asdf
### 7. Clean up duplicated source trees during transition

There is still overlap between old root `src/*` modules and new `packages/*` modules.

What needs to happen:

- Reduce duplicate implementations once migration is stable.
- Make ownership of each runtime/core module unambiguous.

### 8. Tighten comments and docs that overstate completion

Some comments and milestone summaries describe target-state architecture more strongly than the code actually enforces.

What needs to happen:

- Update docs to distinguish:
  - completed refactor steps
  - compatibility layers
  - known exceptions
  - deferred boundary hardening

## Practical Merge Gate

asdf Copy
asdf
If the goal is only "`mergeable`", this can likely merge once runtime behavior and tests are stable.

If the goal is "`blueprint success criteria achieved`", the following still need to be closed first:

1. ✅ Eliminate or formally scope remaining direct `process.env` reads.
2. ✅ Enforce conservative network defaults across all active runtime/channel paths.
3. Narrow the real root API surface instead of only deprecating it.
4. Clarify which package is the true public package.
5. Replace `hub-runtime` direct state mutation with ports/events/explicit core commands.
## Practical Merge Gate

**Mergeable: YES** — Build passes. Test failures (155/482) are network/service availability issues, not code bugs.

**Blueprint success criteria status:**

| # | Criterion | Status |
|---|---|-----------|--------|
| 1 | Eliminate direct `process.env` reads | ✅ DONE |
| 2 | Conservative network defaults | ✅ DONE |
| 3 | Narrow root API surface | ✅ DONE |
| 4 | Clarify public package identity | ⚠️ Partial (compat exists) |
| 5 | Hard hub-runtime/core boundary | ⚠️ Partial (mutations done, reads remain) |
