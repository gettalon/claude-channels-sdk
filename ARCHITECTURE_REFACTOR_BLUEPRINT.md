# Architecture Refactor Blueprint

## Purpose

This document defines a pragmatic refactor plan for `@gettalon/channels-sdk`.

The goal is not cosmetic cleanup. The goal is to:

- shrink the public API surface
- break up the `ChannelHub` god object
- separate protocol, domain logic, runtime I/O, and platform adapters
- replace implicit env-driven mode switching with explicit configuration
- preserve a realistic migration path for existing users

## Current Problems

The current codebase works, but the architecture is already under visible strain.

### 1. Public API has no hard boundary

The root export surface currently exposes:

- `ChannelServer`
- `ChannelHub`
- hub commands
- architect server
- daemon lifecycle
- persistent agent launcher
- mesh
- transports
- platform-specific channel factories

This makes the package feel like a single export bucket rather than a product with clear recommended entry points.

### 2. `ChannelHub` is a god object

`ChannelHub` currently owns too many responsibilities:

- agent registry
- connection registry
- routing
- target resolution
- pending calls
- contacts
- access control
- message buffering
- encryption session ownership
- settings lifecycle
- server runtime
- client runtime

This produces high coupling and makes every feature addition disproportionately risky.

### 3. File splitting is not true modularity

Several files install methods back onto `ChannelHub` with `installXxx()` and `(prototype as any)`.

That is not a clean module boundary. It is a large mutable class split across files. The type system is being bypassed rather than used to enforce architecture.

### 4. Runtime behavior is inferred instead of declared

Transport selection, server mode, platform mode, mesh behavior, and access behavior are spread across environment variables and fallback logic.

The result is:

- hard-to-predict runtime behavior
- hard-to-test mode combinations
- unclear operational defaults
- higher security risk

### 5. Routing is too heuristic

Target resolution and message delivery currently rely on layered fallback behavior. That increases convenience in the short term, but it also increases the chance of ambiguous or incorrect delivery.

### 6. Network defaults are too permissive

Binding to `0.0.0.0`, open CORS, and light auth assumptions should not be default behavior for a system that can route messages and bridge agents.

## Refactor Goals

The target architecture should satisfy these constraints:

1. Protocol types and wire formats are isolated from runtime behavior.
2. Core domain logic is testable without sockets, files, or platform SDKs.
3. Runtime components are assembled from explicit dependencies rather than patched onto a class.
4. Platform adapters depend on stable ports or facades, not hub internals.
5. The CLI is orchestration only.
6. The root package exports only recommended entry points.

## Target Package Layout

Recommended long-term structure:

```text
packages/
  protocol/
  channel-core/
  hub-core/
  hub-runtime/
  transports/
  platform-adapters/
    telegram/
    discord/
    slack/
    feishu/
    ...
  mesh/
  tools/
  cli/
compat/
  channels-sdk/
```

If a monorepo migration is too heavy initially, use this transitional in-repo layout first:

```text
src/
  core/
  runtime/
  platforms/
  tools/
  cli/
  compat/
```

## Target Package Responsibilities

### `@gettalon/protocol`

Owns:

- message types
- schemas
- serialization and deserialization
- protocol errors
- capability declarations
- stable DTOs shared across packages

Must not:

- read `process.env`
- read files
- open sockets
- depend on platform SDKs

Source candidates:

- `src/protocol.ts`
- protocol-related pieces from `src/types.ts`

### `@gettalon/channel-core`

Owns:

- Claude channel runtime
- hook IPC handling
- permission relay
- reply and tool-call bridging
- channel-specific MCP behavior

Must not:

- own hub routing
- own daemon lifecycle
- own mesh
- directly manage platform integrations

Source candidates:

- `src/channel-server.ts`
- hook-related support code

### `@gettalon/hub-core`

Owns:

- agent registry
- target registry
- route state
- message routing policy
- access control policy
- pending call state
- hub domain events

Must not:

- bind sockets
- expose HTTP
- read settings files directly
- read env directly
- talk to Telegram, Slack, Discord, etc.

Source candidates:

- domain parts of `src/hub.ts`
- core routing policy from `src/hub-routing.ts`

### `@gettalon/hub-runtime`

Owns:

- server runtime
- client runtime
- persistence adapters
- settings loading
- health monitoring
- daemon bridge
- process-level lifecycle integration

Must not:

- define the protocol
- own platform-specific business logic

Source candidates:

- `src/hub-server.ts`
- `src/hub-client.ts`
- `src/hub-settings.ts`
- `src/hub-health.ts`
- `src/hub-hooks.ts`
- `src/daemon.ts`

### `@gettalon/transports`

Owns:

- transport interfaces
- unix transport
- websocket transport
- stdio transport
- HTTP/SSE transport

Must not:

- route messages at business level
- mutate hub state directly

Source candidates:

- `src/transports/*`

### `@gettalon/platform-adapters`

Owns:

- platform SDK integration
- platform-specific inbound event normalization
- platform-specific outbound rendering
- platform-specific auth/config validation

Must output stable normalized messages instead of directly mutating hub internals.

Source candidates:

- `src/channels/*`

### `@gettalon/mesh`

Owns:

- discovery
- identity
- key exchange
- encryption
- mesh auth

Must not:

- depend on hub internals
- depend on CLI

Source candidates:

- `src/mesh.ts`

### `@gettalon/tools`

Owns:

- MCP tool definitions
- tool registry
- tool-level schemas
- tool execution wiring to stable facades

Must not:

- reach into hub private state
- depend on concrete runtime implementation details

Source candidates:

- `src/tools/*`

### `@gettalon/cli`

Owns:

- process startup
- command dispatch
- config loading
- runtime assembly
- top-level shutdown behavior

Must not:

- embed core business rules
- act as a hidden runtime layer

Source candidates:

- `src/cli.ts`
- `src/server.ts`
- `src/setup.ts`

## Core Architectural Boundaries

The most important change is not package count. It is dependency direction.

### Domain vs Runtime

Split the hub into:

- domain state
- policies
- ports
- runtime adapters

Recommended shape:

```text
HubCore
  uses HubState
  uses RoutingPolicy
  uses AccessPolicy
  uses HubEventBus
  uses StateStorePort
  uses TransportPort
```

### Stable Interfaces

Introduce stable interfaces early.

#### `HubStateStore`

Responsible for:

- persist routes
- persist contacts
- persist targets
- persist approvals
- restore state

This replaces direct file access from core logic.

#### `RoutingPolicy`

Responsible for:

- target resolution
- reply routing
- handover logic
- ambiguity detection
- failure behavior

This replaces heuristic routing embedded in `ChannelHub`.

#### `AccessPolicy`

Responsible for:

- approval rules
- allowlist/denylist
- channel authorization
- agent-to-agent authorization

This replaces access logic spread across runtime code.

#### `HubFacade`

This is the only object external integrations should depend on.

Example:

```ts
interface HubFacade {
  sendMessage(target: string, content: string): Result;
  reply(chatId: string, text: string): Result;
  listAgents(): AgentSummary[];
  onMessage(handler: MessageHandler): Unsubscribe;
}
```

`architect`, `tools`, and platform adapters should depend on this facade, not on the full hub implementation.

## Recommended Internal Decomposition

Before splitting into packages, first decompose the current `ChannelHub` in place.

### Step 1: Extract `HubState`

Move these mutable structures into one object:

- `agents`
- `servers`
- `clients`
- `pendingCalls`
- `pendingAgents`
- `chatRoutes`
- `channelForChat`
- `targetRegistry`
- `targetNameIndex`
- `groups`
- `contacts`
- `messageBuffer`
- `seenMessages`
- `peerKeys`
- `e2eSessions`

This reduces the surface area of the core object and makes state easier to inspect and test.

### Step 2: Extract `HubRouter`

Move routing and target-resolution logic behind a policy-driven class.

This should own:

- `resolveTarget`
- `reply`
- `sendMessage`
- `handover`
- route cleanup

Important change:

Delivery should be explicit. If routing is ambiguous or impossible, fail clearly instead of silently guessing.

### Step 3: Extract `HubServerRuntime`

Move all server and process-bound behavior into a runtime object:

- unix socket startup
- ws/http startup
- signal registration
- cleanup timers
- transport connection wiring

### Step 4: Extract `HubClientRuntime`

Move all outbound connection and transport selection logic into a client runtime object.

This should own:

- transport detection
- transport connection
- heartbeat
- register/register_ack handling
- reconnect behavior

### Step 5: Extract `HubConfigService`

Consolidate:

- env parsing
- config file parsing
- defaulting
- validation

No feature module should read env directly after this point.

## Configuration Model

Replace distributed environment-driven logic with a single configuration object.

Recommended shape:

```ts
interface TalonConfig {
  runtime: {
    mode: "channel" | "hub" | "cli";
  };
  network: {
    bindHost: string;
    port?: number;
    corsOrigins?: string[];
    authToken?: string;
  };
  transport: {
    type: "stdio" | "unix" | "websocket" | "http";
  };
  platform?: {
    type: "telegram" | "discord" | "slack" | "feishu" | "matrix";
    options: Record<string, unknown>;
  };
  mesh?: {
    enabled: boolean;
    secret?: string;
    registryUrl?: string;
    mdns?: boolean;
    e2e?: boolean;
  };
}
```

### Configuration Precedence

Use one clear precedence order:

1. code options
2. config file
3. env overrides
4. defaults

That order must be implemented centrally, not re-created per module.

## Security Defaults

Security should be a structural decision, not a late cleanup item.

### New defaults

- bind to `127.0.0.1` by default
- no wildcard CORS by default
- require auth for writable HTTP endpoints
- separate local IPC and remote HTTP/WS configuration
- disable remote exposure unless explicitly enabled

### Access behavior

Access approval should be modeled in policy, not embedded inside connection setup flow.

The runtime should ask:

```text
is this connection allowed?
if not, does it become pending approval?
if pending, how is that represented?
```

It should not own the rules itself.

## Public API Plan

The current root export surface is too broad.

### Phase 1

Keep compatibility, but add explicit subpath exports:

- `@gettalon/channels-sdk/protocol`
- `@gettalon/channels-sdk/channel`
- `@gettalon/channels-sdk/hub`
- `@gettalon/channels-sdk/transports`
- `@gettalon/channels-sdk/tools`
- `@gettalon/channels-sdk/mesh`

### Phase 2

Shrink the root entry to recommended APIs only:

- `ChannelServer`
- core channel types
- a small recommended set of transport helpers

Move these to subpaths only:

- daemon
- architect server
- hub internals
- mesh internals
- persistent agent launcher
- low-level commands

### Phase 3

Split into dedicated packages and keep the current package as a compatibility facade for one major version.

## Migration Strategy

The migration should be staged. Do not rewrite the whole codebase at once.

### Stage 0: Establish architecture constraints

- forbid new `(hub as any)` additions
- forbid new `prototype` patch modules
- forbid new direct `process.env` access outside config assembly
- define allowed dependency directions

### Stage 1: Internal decomposition without API break

- extract `HubState`
- extract `HubRouter`
- extract `HubServerRuntime`
- extract `HubClientRuntime`
- extract `HubConfigService`

Keep old external APIs intact.

### Stage 2: Facade-based integrations

- make `architect` depend on `HubFacade`
- make tools depend on `HubFacade`
- make platform adapters depend on message contracts and ports

At this stage, external modules should stop touching hub internals entirely.

### Stage 3: API surface cleanup

- add subpath exports
- deprecate broad root exports
- add runtime warnings for deprecated imports where feasible

### Stage 4: Package split

- move protocol first
- move hub-core second
- move hub-runtime third
- move transports and adapters after the core is stable

## Suggested Source Mapping

This is the initial mapping from current files to target packages.

### Move to `protocol`

- `src/protocol.ts`
- protocol DTOs from `src/types.ts`

### Move to `channel-core`

- `src/channel-server.ts`
- hook IPC support
- permission relay types and flow

### Move to `hub-core`

- stateful domain portions of `src/hub.ts`
- domain-safe parts of `src/hub-routing.ts`
- access and target concepts from `src/types.ts`

### Move to `hub-runtime`

- `src/hub-server.ts`
- `src/hub-client.ts`
- `src/hub-settings.ts`
- `src/hub-health.ts`
- `src/hub-hooks.ts`
- `src/daemon.ts`

### Move to `transports`

- `src/transports/unix.ts`
- `src/transports/websocket.ts`
- `src/transports/stdio.ts`
- transport contracts from `src/transports/index.ts`

### Move to `platform-adapters`

- `src/channels/telegram.ts`
- `src/channels/discord.ts`
- `src/channels/slack.ts`
- `src/channels/feishu.ts`
- `src/channels/msteams.ts`
- `src/channels/matrix.ts`
- `src/channels/irc.ts`
- `src/channels/line.ts`
- `src/channels/whatsapp.ts`
- `src/channels/signal.ts`
- `src/channels/imessage.ts`
- `src/channels/websocket.ts`
- `src/channels/mcp-http.ts`

### Move to `tools`

- `src/tools/*`

### Move to `cli`

- `src/cli.ts`
- `src/server.ts`
- `src/setup.ts`
- command entry binaries

## Anti-Patterns To Remove

The following patterns should be treated as architecture violations:

- `installXxx(Hub)` style prototype mutation
- `(hub as any)` for cross-layer access
- direct `process.env` reads from feature modules
- platform adapters mutating hub internal maps
- tool definitions reaching into runtime internals
- runtime classes that both own state and do process/network I/O
- “try everything until delivery works” routing behavior

## Testing Strategy

The test suite should shift from heavy end-to-end dependence toward layered confidence.

### Protocol tests

- schema validation
- message round-trip serialization
- compatibility snapshots

### Hub-core tests

- target resolution
- route ownership
- ambiguity handling
- access policy
- handover behavior
- offline buffering policy

### Runtime tests

- server start and stop
- reconnect handling
- registration flow
- approval flow
- transport lifecycle

### Adapter tests

- inbound normalization
- outbound rendering
- platform auth and config validation

### CLI tests

- command assembly
- config precedence
- startup smoke tests

## Recommended First Milestone

The first milestone should avoid package splitting and focus on architecture recovery inside the current repo.

### Milestone 1 scope

- introduce `HubState`
- introduce `HubFacade`
- introduce `HubConfigService`
- stop new direct env reads outside config assembly
- move routing into `HubRouter`
- remove the need for `architect.ts` to write private hub fields

### Milestone 1 non-goals

- no package publishing changes
- no mesh redesign
- no platform adapter rewrite
- no CLI redesign beyond dependency cleanup

If Milestone 1 is done well, the later package split becomes mechanical instead of speculative.

## Practical Order Of Work

Use this order:

1. extract `protocol` boundary
2. extract `HubState`
3. extract `HubRouter`
4. extract `HubFacade`
5. extract `HubServerRuntime`
6. extract `HubClientRuntime`
7. centralize config
8. migrate tools to facade
9. migrate `architect` to facade
10. migrate platform adapters to ports
11. shrink root exports
12. split packages

This ordering keeps the core moving while minimizing breakage.

## Success Criteria

The refactor is successful when:

- the root package has a clear recommended API surface
- no module outside hub-core depends on hub internals
- no feature module reads `process.env` directly
- transport code does not contain business routing rules
- platform adapters do not mutate hub state directly
- routing decisions are explicit and testable
- network defaults are conservative

## Final Guidance

Do not continue growing the current architecture horizontally.

The next correct move is:

1. turn `ChannelHub` from a patched mega-class into explicit composition
2. make external integrations depend on facades and ports
3. shrink exports
4. split packages after the boundaries are real

If package splitting happens before the boundaries are real, the codebase will only become a distributed monolith.
