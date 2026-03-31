# Final Review And Decision

Status recorded on 2026-03-31 for the current checked-out repository state.

## Final Review

The team report is directionally positive, but still slightly overstated.

What is credibly done:

- Root API narrowing is real.
- Package identity is much clearer.
- Conservative defaults were improved in the previously flagged paths.
- The `hub-runtime` to `hub-core` boundary is better than before.

What is not fully true yet:

### 1. Env centralization is not fully complete

Active entry/runtime paths are clean: `server.ts`, `telegram.ts`, `websocket.ts`, `cli.ts`
no longer read env directly. What remains is all categorized:

- Designated reader: `packages/hub-runtime/src/hub-config-service.ts` (intentional)
- Sanctioned bootstrap: `packages/hub-runtime/src/hub-settings.ts:15` (intentional)
- Documented legacy exceptions: e.g. `src/channels/matrix.ts:8`, `src/channels/slack.ts:8`
  (sanctioned with comments, deferred migration)
- Intentional env pass-through to child processes: `packages/hub-runtime/src/daemon.ts:140`,
  `src/cli.ts:261` (commented as intentional)

Conclusion:

- Active runtime paths are closed.
- Remaining reads are categorized and documented, not uncategorized noise.
- The literal "no feature module reads process.env" criterion is still not met due to
  legacy channel adapters, but the scope is bounded and explicit.

### 2. The `hub-runtime` / `hub-core` boundary is improved, but not hard

Agent/chat routing and target registry mutations have been replaced with explicit HubFacade
command methods. The remaining direct map mutations are:

- `hub-server-runtime.ts:66,203` — `hub.servers.set(...)` (server registration)
- `hub-server-runtime.ts:349` — `hub.groups.set/get(...)` (group sync)
- `hub-server-runtime.ts:470` — `hub.pendingCalls.set(...)` (proxy call lifecycle)
- `hub-client-runtime.ts:160` — `hub.peerKeys.set(...)`, `hub.e2eSessions.set(...)` (E2E state)
- `hub-client-runtime.ts:217` — `hub.pendingCalls.get/delete(...)` (pending call resolution)

Conclusion:

- Agent/chat/target mutations now go through the command interface.
- Server registration, group sync, pending call lifecycle, and E2E session state still reach
  into core maps directly.
- The boundary is better, not hard. Full closure requires 6+ additional command methods.

## Mergeability

My judgment:

- `mergeable`: yes, if tests are green and runtime behavior is stable
- `blueprint success fully achieved`: not yet, if judged strictly

The accurate project status is:

- practical refactor milestone: largely successful
- architecture claim of full closure: still too strong

## What To Say Externally

Recommended wording for the team:

> This PR closes most of the Stage 3 gaps and makes the refactor mergeable. Two architectural goals remain partially open: full env centralization and a harder runtime/core boundary.

That wording is honest and still gives them credit for real progress.

## Decision: Compat Package

Decision:

- `@gettalon/channels-sdk-compat` is a temporary backwards-compatibility shim.

Policy:

- New code must import from `@gettalon/channels-sdk`.
- No new features will be added to `@gettalon/channels-sdk-compat`.
- The compat package exists only to support migration of older imports.
- Planned removal version: `2.0.0`.

Reasoning:

- The main public package is already `@gettalon/channels-sdk`.
- The compat package is already described as a shim.
- Keeping the compat package permanent would preserve migration ambiguity.
- A temporary shim keeps migration practical without polluting the long-term package story.

## Exit Criteria Before Removing Compat

- Root package subpath exports are stable.
- Migration docs are published.
- Downstream consumers have a clear upgrade path.
- No new product surface depends on the compat package.

## Recommended Next Steps

### Before Merge

- Confirm the full test suite is green on the exact branch to be merged.
- Avoid claiming that all blueprint criteria are fully closed.

### After Merge

- Finish env centralization scope.
- Finish hardening the `hub-runtime` to `hub-core` boundary.
- Publish migration guidance for consumers.
- Mark compat removal timeline in docs and package metadata.

## Copy-Paste Team Note

```md
Decision: `@gettalon/channels-sdk-compat` is a temporary backwards-compatibility shim.

Policy:
- New code must import from `@gettalon/channels-sdk`.
- No new features will be added to `@gettalon/channels-sdk-compat`.
- The compat package exists only to support migration of older imports.
- Planned removal: `2.0.0`.

Exit criteria before removal:
- root package subpath exports are stable
- migration docs are published
- downstream consumers have a clear upgrade path
```
