# Remaining Fixes

Status based on the current checked-out repository state on 2026-03-31.

This is the gap list that still remains between the current refactor and the blueprint success criteria.

## Must Fix To Claim Blueprint Success

### 1. Direct `process.env` reads still exist in feature/runtime modules

The success criterion "`No feature module reads process.env directly`" is not met yet.

Current examples:

- `src/server.ts`
- `src/channels/telegram.ts`
- `src/channels/websocket.ts`
- `src/transports/telegram.ts`
- `packages/transports/src/telegram.ts`
- `packages/hub-runtime/src/hub-settings.ts`
- `packages/hub-runtime/src/daemon.ts`

There are also many older channel modules still reading env directly, including:

- `src/channels/matrix.ts`
- `src/channels/signal.ts`
- `src/channels/irc.ts`
- `src/channels/whatsapp.ts`
- `src/channels/discord.ts`
- `src/channels/slack.ts`
- `src/channels/line.ts`
- `src/channels/feishu.ts`
- `src/channels/imessage.ts`
- `src/channels/msteams.ts`

What needs to happen:

- Move feature/runtime config loading behind `HubConfigService` or a package-local config service.
- Keep direct env reads only in explicitly designated config/bootstrap modules.
- Document any intentional exception clearly and narrowly.

### 2. Conservative network defaults are not enforced repo-wide

The success criterion "`Network defaults are conservative`" is only partially true.

Current examples that still expose permissive defaults or addresses:

- `src/channels/telegram.ts`
- `src/channels/websocket.ts`
- `src/transports/websocket.ts`
- `src/tools/start-server.ts`
- `src/channels/mcp-http.ts` still has a fallback path that can land on `0.0.0.0`

What needs to happen:

- Default all bind hosts to `127.0.0.1` unless explicitly overridden.
- Remove remaining hardcoded `ws://0.0.0.0:...` URLs.
- Keep CORS opt-in only.
- Make external exposure an explicit config choice, not a fallback.

### 3. Root package API is still broad

The success criterion "`Root package has clear recommended API surface`" is only partially met.

Current state:

- `src/index.ts` still re-exports most of the legacy root surface.
- Most of these exports are only marked `@deprecated`, not removed.

What needs to happen:

- Reduce the root export surface to the actual recommended entry points.
- Keep compatibility exports in subpaths or the compat package.
- Treat deprecated root exports as a transition layer, not the target architecture.

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

### 5. `hub-runtime` still reaches into `hub-core` internals

This was already acknowledged by the team and is still real.

Current state:

- `hub-client-runtime` and `hub-server-runtime` still mutate `chatRoutes`, `targetRegistry`, and related core state directly.
- The split is a package split, not yet a hard boundary.

What needs to happen:

- Introduce ports/events between `hub-core` and `hub-runtime`.
- Stop mutating core maps directly from runtime code.
- Make runtime depend on explicit commands/interfaces instead of state structure.

### 6. Compat path is still doing too much transition work

Current state:

- Root package exports are still used as the main migration path.
- `packages/channels-sdk` exists, but the main release identity has not fully moved to the new package layout.

What needs to happen:

- Decide whether the compat package is temporary or primary.
- If temporary, define the removal schedule.
- If primary, rename and publish accordingly.

## Lower Priority Follow-Up

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

If the goal is only "`mergeable`", this can likely merge once runtime behavior and tests are stable.

If the goal is "`blueprint success criteria achieved`", the following still need to be closed first:

1. Eliminate or formally scope remaining direct `process.env` reads.
2. Enforce conservative network defaults across all active runtime/channel paths.
3. Narrow the real root API surface instead of only deprecating it.
4. Clarify which package is the true public package.
5. Replace `hub-runtime` direct state mutation with ports/events or explicit core commands.
