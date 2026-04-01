# Final Review And Decision
Status updated 2026-04-01 after HubConfigService migration.
asdf Copy
asdf
## Final Review
asdf Copy
The team report direction was positive. This update completes the "Must Fix" items from the blueprint.
asdf Copy
**What is now fully complete:**
asdf Copy
### 1. Env centralization ✅ DONE

All legacy channel adapters and active runtime modules now use `HubConfigService`:

- All `src/channels/*.ts` files migrated to `HubConfigService.*()` accessors
- `src/architect.ts`, `src/daemon.ts`, `src/hub-client.ts` migrated
- `packages/hub-runtime/src/hub-config-service.ts` has ~30 legacy channel accessors

**Sanctioned exceptions** (remain direct env reads):
- `HOME` for temp paths - generic system utility
- `ANTHROPIC_*` keys in agent-launcher - external API credentials
- `TALON_HOME` in hub-settings.ts - bootstrap resolver

### 2. Conservative network defaults ✅ DONE

All network binds now default to `127.0.0.1`:
- `src/channels/mcp-http.ts` → `127.0.0.1`
- `src/hub-server.ts` → `127.0.0.1`
- `HubConfigService.*Host()` methods return `127.0.0.1` by default

**What remains partially open:**
asdf Copy
### 3. The `hub-runtime` / `hub-core` boundary is improved, but not hard

Agent/chat/target mutations now go through the command interface. The remaining direct map mutations are:

- `hub-server-runtime.ts` — `hub.servers.set(...)` (server registration)
- `hub-server-runtime.ts` — `hub.groups.set/get(...)` (group sync)
- `hub-server-runtime.ts` — `hub.pendingCalls.set(...)` (proxy call lifecycle)
- `hub-client-runtime.ts` — `hub.peerKeys.set(...)`, `hub.e2eSessions.set(...)` (E2E state)

Conclusion: The boundary is better, not hard. Full closure requires 6+ additional command methods.

### 4. Root package API is still broad

`src/index.ts` still re-exports most of the legacy surface with `@deprecated` tags. Not yet narrowed.

## Mergeability

**Yes**, with honest framing:
- Practical refactor milestone: **largely successful**
- Two "Must Fix" blueprint items: **closed** ✅
- Architecture claim of full closure: **still too strong**

## What To Say Externally

> This PR closes the two "Must Fix" blueprint gaps: env centralization and network defaults. All legacy channels now use HubConfigService, and all network binds default to localhost. Architectural debt around the runtime/core boundary and API surface remain open for follow-up.

## Decision: Compat Package

**Decision:** `@gettalon/channels-sdk-compat` is a temporary backwards-compatibility shim.

**Policy:**
- New code must import from `@gettalon/channels-sdk`.
- No new features will be added to `@gettalon/channels-sdk-compat`.
- The compat package exists only to support migration of older imports.
- Planned removal version: `2.0.0`.

## Exit Criteria Before Removing Compat

- Root package subpath exports are stable.
- Migration docs are published.
- Downstream consumers have a clear upgrade path.
- No new product surface depends on the compat package.

## Recommended Next Steps
asdf Copy
### Before Merge
- ✅ Confirm tests are green
- ✅ Two "Must Fix" items are closed

### After Merge
- Finish hardening `hub-runtime` to `hub-core` boundary (6+ command methods)
- Narrow root API surface beyond deprecation
- Publish migration guidance for consumers
- Mark compat removal timeline in docs and package metadata

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
