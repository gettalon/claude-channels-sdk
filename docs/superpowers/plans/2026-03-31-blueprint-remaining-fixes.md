# Blueprint Remaining Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close all five "Must Fix" gaps from REMAINING_FIXES.md so the architecture refactor meets its blueprint success criteria.

**Architecture:** `HubConfigService` in `packages/hub-runtime` is the single env-read boundary; all active runtime and channel modules call it instead of `process.env` directly. Network defaults are `127.0.0.1` everywhere. The root `src/index.ts` exports only the stable non-deprecated surface. Hub-runtime accesses hub state exclusively through explicit command methods on `HubFacade`, not by mutating maps directly.

**Tech Stack:** TypeScript, Node.js 20+, workspace monorepo (`packages/`), `npm run build` for compilation.

---

## File Map

**Modified:**
- `packages/hub-runtime/src/hub-config-service.ts` — expand `EnvSnapshot` + add accessor methods
- `src/server.ts` — replace all direct `process.env` reads with `HubConfigService` calls
- `src/channels/telegram.ts` — replace all direct `process.env` reads with `HubConfigService` calls
- `src/transports/telegram.ts` — replace 4 direct `process.env` reads
- `packages/transports/src/telegram.ts` — replace 5 direct `process.env` reads
- `packages/hub-runtime/src/daemon.ts` — replace direct `TELEGRAM_BOT_TOKEN` read
- `src/transports/websocket.ts` — change bind `"0.0.0.0"` → `"127.0.0.1"`
- `src/channels/websocket.ts` — fix mesh reporting `"0.0.0.0"` → actual bound address
- `src/tools/start-server.ts` — change stored URL from `ws://0.0.0.0:${port}` → `ws://127.0.0.1:${port}`
- `src/index.ts` — remove deprecated re-exports (move them to compat only)
- `packages/hub-core/src/hub-facade.ts` — add runtime command methods
- `packages/hub-runtime/src/hub-server-runtime.ts` — use command methods instead of direct map mutations
- `packages/hub-runtime/src/hub-client-runtime.ts` — use command methods instead of direct map mutations
- `packages/channels-sdk/package.json` — clarify compat role
- `packages/hub-runtime/src/hub-settings.ts` — add sanctioned exception comment (already has one)

**Legacy channel modules (add header comment, no code changes):**
- `src/channels/matrix.ts`, `src/channels/signal.ts`, `src/channels/irc.ts`, `src/channels/whatsapp.ts`,
  `src/channels/discord.ts`, `src/channels/slack.ts`, `src/channels/line.ts`, `src/channels/feishu.ts`,
  `src/channels/imessage.ts`, `src/channels/msteams.ts`

---

## Task 1: Expand `HubConfigService` with all active runtime env vars

**Files:**
- Modify: `packages/hub-runtime/src/hub-config-service.ts`

- [ ] **Step 1: Expand `EnvSnapshot` interface**

Replace the existing `EnvSnapshot` interface (lines 41–59) with:

```typescript
interface EnvSnapshot {
  // Core
  TALON_AGENT_NAME?: string;
  TALON_PORT?: string;
  TALON_DEV?: string;
  TALON_HOME?: string;
  TALON_TRANSPORT?: string;
  TALON_CHANNEL?: string;
  // Telegram channel/transport
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_HOST?: string;
  TELEGRAM_WEBHOOK_PORT?: string;
  TELEGRAM_WEBHOOK_PATH?: string;
  TELEGRAM_WEBHOOK_URL?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  TELEGRAM_ALLOWED_CHATS?: string;
  TELEGRAM_ACCESS_PATH?: string;
  TELEGRAM_DOWNLOAD_PATH?: string;
  TELEGRAM_GROUP_TRIGGER?: string;
  TELEGRAM_STREAMING?: string;
  TELEGRAM_GROQ_API_KEY?: string;
  GROQ_API_KEY?: string;
  TELEGRAM_WHISPER_MODEL?: string;
  // Cohere (voice transcription fallback)
  COHERE_API_KEY?: string;
  // MCP-HTTP channel
  MCP_HTTP_PORT?: string;
  MCP_HTTP_HOST?: string;
  MCP_HTTP_TOKEN?: string;
  MCP_HTTP_CORS?: string;
  MCP_HTTP_PATH?: string;
  MCP_HTTP_AGENT_NAME?: string;
  // WebSocket channel
  WS_HOST?: string;
  WS_PORT?: string;
  WS_MODE?: string;
  WS_URL?: string;
  WS_AGENT_NAME?: string;
  WS_PAIR_TOKEN?: string;
  WS_AUTO_RECONNECT?: string;
  WS_HTTP?: string;
  WS_GROUP_NAME?: string;
  WS_GROUP_ACCESS?: string;
  WS_GROUP_MAX_MEMBERS?: string;
  // Mesh
  MESH_SECRET?: string;
  MESH_DEVICE_ID?: string;
  MESH_MDNS?: string;
  MESH_REGISTRY_URL?: string;
  MESH_E2E?: string;
}
```

- [ ] **Step 2: Expand `snapshotEnv()` to read all the new fields**

Replace the existing `snapshotEnv()` function body with:

```typescript
function snapshotEnv(): EnvSnapshot {
  return {
    TALON_AGENT_NAME: process.env.TALON_AGENT_NAME,
    TALON_PORT: process.env.TALON_PORT,
    TALON_DEV: process.env.TALON_DEV,
    TALON_HOME: process.env.TALON_HOME,
    TALON_TRANSPORT: process.env.TALON_TRANSPORT,
    TALON_CHANNEL: process.env.TALON_CHANNEL,
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
    TELEGRAM_WEBHOOK_HOST: process.env.TELEGRAM_WEBHOOK_HOST,
    TELEGRAM_WEBHOOK_PORT: process.env.TELEGRAM_WEBHOOK_PORT,
    TELEGRAM_WEBHOOK_PATH: process.env.TELEGRAM_WEBHOOK_PATH,
    TELEGRAM_WEBHOOK_URL: process.env.TELEGRAM_WEBHOOK_URL,
    TELEGRAM_WEBHOOK_SECRET: process.env.TELEGRAM_WEBHOOK_SECRET,
    TELEGRAM_ALLOWED_CHATS: process.env.TELEGRAM_ALLOWED_CHATS,
    TELEGRAM_ACCESS_PATH: process.env.TELEGRAM_ACCESS_PATH,
    TELEGRAM_DOWNLOAD_PATH: process.env.TELEGRAM_DOWNLOAD_PATH,
    TELEGRAM_GROUP_TRIGGER: process.env.TELEGRAM_GROUP_TRIGGER,
    TELEGRAM_STREAMING: process.env.TELEGRAM_STREAMING,
    TELEGRAM_GROQ_API_KEY: process.env.TELEGRAM_GROQ_API_KEY,
    GROQ_API_KEY: process.env.GROQ_API_KEY,
    TELEGRAM_WHISPER_MODEL: process.env.TELEGRAM_WHISPER_MODEL,
    COHERE_API_KEY: process.env.COHERE_API_KEY,
    MCP_HTTP_PORT: process.env.MCP_HTTP_PORT,
    MCP_HTTP_HOST: process.env.MCP_HTTP_HOST,
    MCP_HTTP_TOKEN: process.env.MCP_HTTP_TOKEN,
    MCP_HTTP_CORS: process.env.MCP_HTTP_CORS,
    MCP_HTTP_PATH: process.env.MCP_HTTP_PATH,
    MCP_HTTP_AGENT_NAME: process.env.MCP_HTTP_AGENT_NAME,
    WS_HOST: process.env.WS_HOST,
    WS_PORT: process.env.WS_PORT,
    WS_MODE: process.env.WS_MODE,
    WS_URL: process.env.WS_URL,
    WS_AGENT_NAME: process.env.WS_AGENT_NAME,
    WS_PAIR_TOKEN: process.env.WS_PAIR_TOKEN,
    WS_AUTO_RECONNECT: process.env.WS_AUTO_RECONNECT,
    WS_HTTP: process.env.WS_HTTP,
    WS_GROUP_NAME: process.env.WS_GROUP_NAME,
    WS_GROUP_ACCESS: process.env.WS_GROUP_ACCESS,
    WS_GROUP_MAX_MEMBERS: process.env.WS_GROUP_MAX_MEMBERS,
    MESH_SECRET: process.env.MESH_SECRET,
    MESH_DEVICE_ID: process.env.MESH_DEVICE_ID,
    MESH_MDNS: process.env.MESH_MDNS,
    MESH_REGISTRY_URL: process.env.MESH_REGISTRY_URL,
    MESH_E2E: process.env.MESH_E2E,
  };
}
```

- [ ] **Step 3: Add accessor methods to `HubConfigService` class**

After the existing `wsHost()` method and before `get envAgentName`, insert these new accessors:

```typescript
// ── Telegram channel accessors ───────────────────────────────────────

/** Telegram allowed chat IDs (comma-separated string or undefined). */
telegramAllowedChats(): string | undefined {
  return this.env.TELEGRAM_ALLOWED_CHATS;
}
/** Path to Telegram access.json file. */
telegramAccessPath(): string | undefined {
  return this.env.TELEGRAM_ACCESS_PATH;
}
/** Path for Telegram file downloads. */
telegramDownloadPath(): string | undefined {
  return this.env.TELEGRAM_DOWNLOAD_PATH;
}
/** Telegram group trigger mode (default "mention"). */
telegramGroupTrigger(): string {
  return this.env.TELEGRAM_GROUP_TRIGGER ?? "mention";
}
/** Whether Telegram streaming updates are enabled (default true). */
telegramStreaming(): boolean {
  return this.env.TELEGRAM_STREAMING !== "false";
}
/** Telegram webhook port (default 3000). */
telegramWebhookPort(codeOption?: number): number {
  if (codeOption !== undefined) return codeOption;
  return parseInt(this.env.TELEGRAM_WEBHOOK_PORT ?? "3000", 10);
}
/** Telegram webhook path (default "/webhook"). */
telegramWebhookPath(codeOption?: string): string {
  return codeOption ?? this.env.TELEGRAM_WEBHOOK_PATH ?? "/webhook";
}
/** Telegram webhook URL (for setWebhook). */
telegramWebhookUrl(codeOption?: string): string | undefined {
  return codeOption ?? this.env.TELEGRAM_WEBHOOK_URL;
}
/** Telegram webhook secret token. */
telegramWebhookSecret(codeOption?: string): string | undefined {
  return codeOption ?? this.env.TELEGRAM_WEBHOOK_SECRET;
}
/** Groq API key for voice transcription. */
groqApiKey(codeOption?: string): string | undefined {
  return codeOption ?? this.env.TELEGRAM_GROQ_API_KEY ?? this.env.GROQ_API_KEY;
}
/** Whisper model name (default "base"). */
telegramWhisperModel(codeOption?: string): string {
  return codeOption ?? this.env.TELEGRAM_WHISPER_MODEL ?? "base";
}
/** Cohere API key for voice transcription fallback. */
cohereApiKey(codeOption?: string): string | undefined {
  return codeOption ?? this.env.COHERE_API_KEY;
}

// ── WebSocket channel accessors ──────────────────────────────────────

/** WebSocket server port (default 8080). */
wsPort(codeOption?: number): number {
  if (codeOption !== undefined) return codeOption;
  return parseInt(this.env.WS_PORT ?? "8080", 10);
}
/** WebSocket mode: "server" | "client" | "both" (default "both"). */
wsMode(codeOption?: string): string {
  return codeOption ?? this.env.WS_MODE ?? "both";
}
/** WebSocket remote URL to connect to (client mode). */
wsUrl(codeOption?: string): string | undefined {
  return codeOption ?? this.env.WS_URL;
}
/** WebSocket agent name for registration. */
wsAgentName(codeOption?: string): string | undefined {
  return codeOption ?? this.env.WS_AGENT_NAME;
}
/** WebSocket pairing token. */
wsPairToken(codeOption?: string): string | undefined {
  return codeOption ?? this.env.WS_PAIR_TOKEN;
}
/** Whether auto-reconnect is enabled (default true). */
wsAutoReconnect(): boolean {
  return this.env.WS_AUTO_RECONNECT !== "false";
}
/** Whether HTTP endpoint alongside WS is enabled (default true). */
wsHttpEnabled(): boolean {
  return this.env.WS_HTTP !== "false";
}
/** WebSocket group name. */
wsGroupName(): string | undefined {
  return this.env.WS_GROUP_NAME;
}
/** WebSocket group access mode (default "public"). */
wsGroupAccess(): "public" | "private" | "invite" {
  return (this.env.WS_GROUP_ACCESS ?? "public") as "public" | "private" | "invite";
}
/** WebSocket group max members (default 0 = unlimited). */
wsGroupMaxMembers(): number {
  return parseInt(this.env.WS_GROUP_MAX_MEMBERS ?? "0", 10);
}

// ── Mesh accessors ───────────────────────────────────────────────────

/** Mesh shared secret (enables mesh mode). */
meshSecret(): string | undefined {
  return this.env.MESH_SECRET;
}
/** Mesh device ID. */
meshDeviceId(): string | undefined {
  return this.env.MESH_DEVICE_ID;
}
/** Whether mDNS is enabled (default true). */
meshMdns(): boolean {
  return this.env.MESH_MDNS !== "false";
}
/** Mesh registry URL. */
meshRegistryUrl(): string | undefined {
  return this.env.MESH_REGISTRY_URL;
}
/** Whether E2E encryption is enabled (default false). */
meshE2e(): boolean {
  return this.env.MESH_E2E === "true";
}

// ── Talon bootstrap accessors ────────────────────────────────────────

/** TALON_CHANNEL override for platform adapter selection. */
talonChannel(): string | undefined {
  return this.env.TALON_CHANNEL?.toLowerCase();
}
```

- [ ] **Step 4: Build and verify**

```bash
cd /Users/qiangwei/projects/talon/claude-channels-sdk
npm run build 2>&1 | tail -20
```

Expected: no TypeScript errors in `packages/hub-runtime/`.

- [ ] **Step 5: Commit**

```bash
git add packages/hub-runtime/src/hub-config-service.ts
git commit -m "feat(config): expand HubConfigService with all active runtime env vars"
```

---

## Task 2: Fix `src/server.ts` — route all env reads through HubConfigService

**Files:**
- Modify: `src/server.ts`

- [ ] **Step 1: Replace platform channel detection (line 58)**

Change:
```typescript
const platformChannel = process.env.TALON_CHANNEL?.toLowerCase();
```
To:
```typescript
const cfg = HubConfigService.fromEnv();
const platformChannel = cfg.talonChannel();
```

Also change the top constant (line 43):
```typescript
const transport = HubConfigService.fromEnv().talonTransport();
```
To:
```typescript
const cfg = HubConfigService.fromEnv();
const transport = cfg.talonTransport();
```

- [ ] **Step 2: Replace `startWebSocket()` env reads (lines 111–146)**

Replace the body of `startWebSocket()`:
```typescript
async function startWebSocket(): Promise<void> {
  const { createWebSocketChannel } = await import("./channels/websocket.js");

  const groupName = cfg.wsGroupName();
  const groupAccess = cfg.wsGroupAccess();
  const maxMembers = cfg.wsGroupMaxMembers();

  const { channel, cleanup } = await createWebSocketChannel({
    mode: cfg.wsMode() as "server" | "client" | "both",
    port: cfg.wsPort(),
    host: cfg.wsHost(),
    url: cfg.wsUrl(),
    agentName: cfg.wsAgentName(),
    pairToken: cfg.wsPairToken(),
    autoReconnect: cfg.wsAutoReconnect(),
    httpEnabled: cfg.wsHttpEnabled(),
    group: groupName ? { name: groupName, access: groupAccess, maxMembers: maxMembers || undefined } : undefined,
    mesh: cfg.meshSecret() ? {
      meshSecret: cfg.meshSecret()!,
      deviceId: cfg.meshDeviceId(),
      agentName: cfg.wsAgentName(),
      port: cfg.wsPort(),
      mdns: cfg.meshMdns(),
      registryUrl: cfg.meshRegistryUrl(),
      e2e: cfg.meshE2e(),
    } : undefined,
  });

  await channel.start();

  const mode = cfg.wsMode();
  const port = cfg.wsPort();
  const features = [
    `mode=${mode}`,
    `port=${port}`,
    groupName ? `group=${groupName}(${groupAccess})` : null,
    cfg.meshSecret() ? "mesh" : null,
    cfg.meshE2e() ? "e2e" : null,
  ].filter(Boolean).join(", ");

  process.stderr.write(`[channels] Ready (ws+http+stdio MCP) [${features}]\n`);

  const shutdown = () => { cleanup(); process.exit(0); };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
```

- [ ] **Step 3: Build and verify**

```bash
npm run build 2>&1 | grep -E "error|warning" | head -20
```

Expected: no errors from `src/server.ts`.

- [ ] **Step 4: Verify no remaining `process.env` reads in server.ts**

```bash
grep -n "process\.env" src/server.ts
```

Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts
git commit -m "fix(server): replace all process.env reads with HubConfigService"
```

---

## Task 3: Fix `src/channels/telegram.ts` — route all env reads through HubConfigService

**Files:**
- Modify: `src/channels/telegram.ts`

The file already imports `HubConfigService` from `"../hub-config-service.js"` (line 24). The direct reads are in the `createTelegramChannel()` function (around lines 177–192 and 897).

- [ ] **Step 1: Locate and replace the env reads block**

Find this block (around line 175 in `createTelegramChannel`):
```typescript
const botToken = HubConfigService.fromEnv().telegramBotToken();
```
(or similar existing call), then further down:
```typescript
  const allowedChats = process.env.TELEGRAM_ALLOWED_CHATS
  ...
  const groqApiKey = process.env.TELEGRAM_GROQ_API_KEY ?? process.env.GROQ_API_KEY;
```

Replace the entire env-reading block at the top of `createTelegramChannel()` with:

```typescript
  const cfg = HubConfigService.fromEnv();
  const botToken = cfg.telegramBotToken();
  if (!botToken) throw new Error("TELEGRAM_BOT_TOKEN is required");

  const allowedChatsRaw = cfg.telegramAllowedChats();
  const allowedChats = allowedChatsRaw
    ? allowedChatsRaw.split(",").map((s) => s.trim()).filter(Boolean)
    : undefined;
  const accessPath = cfg.telegramAccessPath();
  const downloadPath = cfg.telegramDownloadPath();
  const groupTrigger = cfg.telegramGroupTrigger() as TelegramConfig["groupTrigger"];
  const streamingUpdates = cfg.telegramStreaming();
  const webhookPort = cfg.telegramWebhookPort();
  const webhookHost = cfg.telegramWebhookHost();
  const webhookPath = cfg.telegramWebhookPath();
  const webhookUrl = cfg.telegramWebhookUrl();
  const webhookSecret = cfg.telegramWebhookSecret();
  const groqApiKey = cfg.groqApiKey();
  const whisperModel = cfg.telegramWhisperModel();
```

- [ ] **Step 2: Replace the `agentName` read (line 897)**

Find:
```typescript
  const agentName = process.env.TALON_AGENT_NAME;
```
Replace with:
```typescript
  const agentName = cfg.envAgentName;
```

- [ ] **Step 3: Verify no remaining `process.env` reads**

```bash
grep -n "process\.env" src/channels/telegram.ts
```

Expected: no output.

- [ ] **Step 4: Build and verify**

```bash
npm run build 2>&1 | grep -E "error" | head -20
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/channels/telegram.ts
git commit -m "fix(telegram): replace all process.env reads with HubConfigService"
```

---

## Task 4: Fix `src/transports/telegram.ts` and `packages/transports/src/telegram.ts`

**Files:**
- Modify: `src/transports/telegram.ts`
- Modify: `packages/transports/src/telegram.ts`

Both files have direct reads for COHERE_API_KEY, TELEGRAM_WEBHOOK_URL, TELEGRAM_WEBHOOK_PORT, TELEGRAM_WEBHOOK_PATH. Both already import `HubConfigService`.

- [ ] **Step 1: Fix `src/transports/telegram.ts` (lines 597–600)**

Find the constructor block that reads env:
```typescript
    this.cohereApiKey = (config.cohereApiKey as string) ?? process.env.COHERE_API_KEY ?? undefined;
    this.webhookUrl = (config.webhookUrl as string) ?? process.env.TELEGRAM_WEBHOOK_URL ?? undefined;
    this.webhookPort = (config.webhookPort as number) ?? parseInt(process.env.TELEGRAM_WEBHOOK_PORT ?? "3001", 10);
    this.webhookPath = (config.webhookPath as string) ?? process.env.TELEGRAM_WEBHOOK_PATH ?? "/telegram/webhook";
```

Replace with:
```typescript
    const _cfg = HubConfigService.fromEnv();
    this.cohereApiKey = (config.cohereApiKey as string) ?? _cfg.cohereApiKey();
    this.webhookUrl = (config.webhookUrl as string) ?? _cfg.telegramWebhookUrl();
    this.webhookPort = (config.webhookPort as number) ?? _cfg.telegramWebhookPort(undefined);
    this.webhookPath = (config.webhookPath as string) ?? _cfg.telegramWebhookPath();
```

Note: `telegramWebhookPort()` defaults to 3000 (from Task 1). The legacy transport used 3001. Verify the original default in the constructor and use `parseInt(this.env.TELEGRAM_WEBHOOK_PORT ?? "3001", 10)` in a new `telegramTransportWebhookPort()` accessor if the port differs — or accept the default change.

Actually, add a separate accessor to `HubConfigService` for the transport's default port:
```typescript
/** Telegram transport webhook port (default 3001 — used by TelegramAdapter, not the channel). */
telegramTransportWebhookPort(codeOption?: number): number {
  if (codeOption !== undefined) return codeOption;
  return parseInt(this.env.TELEGRAM_WEBHOOK_PORT ?? "3001", 10);
}
```

Then in `src/transports/telegram.ts`:
```typescript
    this.webhookPort = (config.webhookPort as number) ?? _cfg.telegramTransportWebhookPort();
```

- [ ] **Step 2: Fix `packages/transports/src/telegram.ts` (lines 594–599)**

Find:
```typescript
    this.token = (config.botToken as string) ?? process.env.TELEGRAM_BOT_TOKEN ?? "";
    ...
    this.cohereApiKey = (config.cohereApiKey as string) ?? process.env.COHERE_API_KEY ?? undefined;
    this.webhookUrl = (config.webhookUrl as string) ?? process.env.TELEGRAM_WEBHOOK_URL ?? undefined;
    this.webhookPort = (config.webhookPort as number) ?? parseInt(process.env.TELEGRAM_WEBHOOK_PORT ?? "3001", 10);
    this.webhookPath = (config.webhookPath as string) ?? process.env.TELEGRAM_WEBHOOK_PATH ?? "/telegram/webhook";
```

Replace with:
```typescript
    const _cfg = HubConfigService.fromEnv();
    this.token = (config.botToken as string) ?? _cfg.telegramBotToken() ?? "";
    ...
    this.cohereApiKey = (config.cohereApiKey as string) ?? _cfg.cohereApiKey();
    this.webhookUrl = (config.webhookUrl as string) ?? _cfg.telegramWebhookUrl();
    this.webhookPort = (config.webhookPort as number) ?? _cfg.telegramTransportWebhookPort();
    this.webhookPath = (config.webhookPath as string) ?? _cfg.telegramWebhookPath();
```

Check if `packages/transports/src/telegram.ts` already imports `HubConfigService`. If not, add:
```typescript
import { HubConfigService } from "@gettalon/hub-runtime";
```

- [ ] **Step 3: Add `telegramTransportWebhookPort` accessor to hub-config-service.ts**

In `packages/hub-runtime/src/hub-config-service.ts`, after `telegramWebhookPort()`, add:
```typescript
/** Telegram transport (TelegramAdapter) webhook port (default 3001). */
telegramTransportWebhookPort(codeOption?: number): number {
  if (codeOption !== undefined) return codeOption;
  return parseInt(this.env.TELEGRAM_WEBHOOK_PORT ?? "3001", 10);
}
```

- [ ] **Step 4: Verify no remaining `process.env` reads**

```bash
grep -n "process\.env" src/transports/telegram.ts packages/transports/src/telegram.ts
```

Expected: no output.

- [ ] **Step 5: Build and verify**

```bash
npm run build 2>&1 | grep "error" | head -20
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/hub-runtime/src/hub-config-service.ts src/transports/telegram.ts packages/transports/src/telegram.ts
git commit -m "fix(transports): replace all process.env reads in Telegram adapters with HubConfigService"
```

---

## Task 5: Fix `packages/hub-runtime/src/daemon.ts` — remove direct TELEGRAM_BOT_TOKEN read

**Files:**
- Modify: `packages/hub-runtime/src/daemon.ts`

The `{ ...process.env }` spreads (lines 139, 256) are intentional — they pass the full environment to spawned child processes. These are sanctioned and should be commented. Only line 224 is the non-sanctioned read.

- [ ] **Step 1: Add sanctioned comments to the `process.env` spreads**

Find line ~139:
```typescript
    env: { ...process.env },
```
Change to:
```typescript
    env: { ...process.env }, // intentional: pass full env to daemon child process
```

Find line ~256 (spawning claude):
```typescript
        env: { ...process.env },
```
Change to:
```typescript
        env: { ...process.env }, // intentional: pass full env to claude subprocess
```

- [ ] **Step 2: Replace the direct TELEGRAM_BOT_TOKEN read (line 224)**

Find:
```typescript
  const telegramToken = (telegramConfig as any)?.botToken ?? process.env.TELEGRAM_BOT_TOKEN;
```
Replace with:
```typescript
  const { HubConfigService } = await import("./hub-config-service.js");
  const telegramToken = (telegramConfig as any)?.botToken ?? HubConfigService.fromEnv().telegramBotToken();
```

Note: the import is dynamic because `daemon.ts` may not have a static import of `HubConfigService` at the top. Check first — if it already imports it statically, use the static import instead.

- [ ] **Step 3: Verify only sanctioned `process.env` references remain**

```bash
grep -n "process\.env" packages/hub-runtime/src/daemon.ts
```

Expected output: only the two `{ ...process.env }` lines with the sanctioned comments.

- [ ] **Step 4: Build and verify**

```bash
npm run build 2>&1 | grep "error" | head -20
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/hub-runtime/src/daemon.ts
git commit -m "fix(daemon): replace direct TELEGRAM_BOT_TOKEN read with HubConfigService; comment sanctioned spreads"
```

---

## Task 6: Add sanctioned-exception comments to legacy channel modules

**Files:**
- Modify (comment only): `src/channels/matrix.ts`, `src/channels/signal.ts`, `src/channels/irc.ts`, `src/channels/whatsapp.ts`, `src/channels/discord.ts`, `src/channels/slack.ts`, `src/channels/line.ts`, `src/channels/feishu.ts`, `src/channels/imessage.ts`, `src/channels/msteams.ts`

These are legacy channel adapters not yet migrated to the new architecture. The env reads are real but the adapters are not on the critical path.

- [ ] **Step 1: Add header comment to each legacy channel file**

At the top of each file, after the existing doc comment block, add:

```typescript
// NOTE: This legacy channel adapter reads process.env directly.
// Sanctioned exception: migrating these to HubConfigService is deferred
// until the adapter is brought into the active monorepo architecture.
// See REMAINING_FIXES.md §1 and packages/hub-runtime/hub-config-service.ts.
```

Files to update:
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

- [ ] **Step 2: Verify**

```bash
grep -rn "process\.env" src/channels/ | grep -v "// intentional\|// NOTE\|// Sanctioned"
```

Expected output: no lines from the 10 legacy files (those lines have the exception comment above them); only output from telegram.ts and websocket.ts if not yet fixed, or nothing after Task 3 completes.

- [ ] **Step 3: Commit**

```bash
git add src/channels/matrix.ts src/channels/signal.ts src/channels/irc.ts src/channels/whatsapp.ts \
        src/channels/discord.ts src/channels/slack.ts src/channels/line.ts src/channels/feishu.ts \
        src/channels/imessage.ts src/channels/msteams.ts
git commit -m "docs(channels): mark legacy channel process.env reads as sanctioned exceptions"
```

---

## Task 7: Fix network defaults — change 0.0.0.0 to 127.0.0.1

**Files:**
- Modify: `src/transports/websocket.ts` (line 59)
- Modify: `src/channels/websocket.ts` (line 887)
- Modify: `src/tools/start-server.ts` (line 23)

- [ ] **Step 1: Fix `src/transports/websocket.ts` bind address**

Find (line ~59):
```typescript
      this.httpServer.listen(port, "0.0.0.0", resolve);
```
Replace with:
```typescript
      this.httpServer.listen(port, (this.config.host as string) ?? "127.0.0.1", resolve);
```

This uses the optional `host` from the config object passed to `WebSocketAdapter`, falling back to `127.0.0.1`. External exposure requires an explicit `host: "0.0.0.0"` option.

- [ ] **Step 2: Fix mesh reporting address in `src/channels/websocket.ts`**

Find (line ~887):
```typescript
    meshRegistry.startReporting({ lan: [{ ip: "0.0.0.0", port }] });
```
Replace with:
```typescript
    // Report the actual bound host. "0.0.0.0" is the all-interfaces wildcard;
    // peers must discover the real address via mDNS or the registry.
    // Use the configured host or fall back to "127.0.0.1" for local-only.
    const reportIp = cfg?.host ?? "127.0.0.1";
    meshRegistry.startReporting({ lan: [{ ip: reportIp, port }] });
```

Note: `cfg` here refers to the `WebSocketConfig` parameter available in scope. Check the surrounding code to confirm the variable name for the config object and adjust accordingly.

- [ ] **Step 3: Fix stored URL in `src/tools/start-server.ts`**

Find (line ~23):
```typescript
    const wsUrl = `ws://0.0.0.0:${port}`;
```
Replace with:
```typescript
    const wsUrl = `ws://127.0.0.1:${port}`;
```

This stored URL is used for settings persistence. Peers that need external access must configure the host explicitly.

- [ ] **Step 4: Verify no remaining 0.0.0.0 in active runtime paths**

```bash
grep -rn "0\.0\.0\.0" src/ packages/hub-runtime/src/ packages/transports/src/ | grep -v "\.bak\|node_modules"
```

Expected: only the mesh fallback peer-IP in `packages/mesh/src/index.ts` (which is parsed data from mDNS, not a bind address — acceptable).

- [ ] **Step 5: Build and verify**

```bash
npm run build 2>&1 | grep "error" | head -20
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/transports/websocket.ts src/channels/websocket.ts src/tools/start-server.ts
git commit -m "fix(network): change all 0.0.0.0 defaults to 127.0.0.1; require explicit external exposure"
```

---

## Task 8: Narrow `src/index.ts` root API surface

**Files:**
- Modify: `src/index.ts`

The goal: remove deprecated re-exports from the root. They belong in the compat package (`packages/channels-sdk`) only. The root keeps: `ChannelServer`, all its types, `BLOCKING_EVENTS`, and the three built-in transport constructors (`createUnixTransport`, `createWebSocketTransport`, `createStdioTransport`).

- [ ] **Step 1: Remove deprecated protocol re-exports (lines 69–100)**

Delete the entire block:
```typescript
/** @deprecated Use `@gettalon/channels-sdk/protocol` instead */
export { MessageType, serialize, deserialize, serializeBuffer, deserializeBuffer, createEnvelope } from "./protocol.js";
/** @deprecated Use `@gettalon/channels-sdk/protocol` instead */
export type {
  ProtocolMessage,
  ...
} from "./protocol.js";
```

- [ ] **Step 2: Remove deprecated transport adapter re-exports (lines 104–118)**

Delete:
```typescript
/** @deprecated Use `@gettalon/channels-sdk/transports` instead */
export { UnixSocketAdapter, WebSocketAdapter, TelegramAdapter, createTelegramTransport, StdioAdapter, StdioTransport } from "./transports/index.js";

/** @deprecated Use `@gettalon/channels-sdk/transports` instead */
export {
  createDiscordTransport,
  createSlackTransport,
  createWhatsAppTransport,
  createMatrixTransport,
  createSignalTransport,
  createIrcTransport,
  createLineTransport,
  createFeishuTransport,
  createMsTeamsTransport,
} from "./transports/index.js";
```

- [ ] **Step 3: Remove deprecated hub re-exports (lines 120–139)**

Delete:
```typescript
/** @deprecated Use `@gettalon/channels-sdk/hub` instead */
export { ChannelHub } from "./hub.js";
/** @deprecated Use `@gettalon/channels-sdk/hub` instead */
export type { AgentState, PendingAgent, HubSettings, ... } from "./hub.js";

/** @deprecated Use `@gettalon/channels-sdk/hub` instead */
export {
  registerCommand, unregisterCommand, ...
} from "./hub-commands.js";
/** @deprecated Use `@gettalon/channels-sdk/hub` instead */
export type { CommandResult, CommandHandler, CommandDef, TalonSettings } from "./hub-commands.js";
```

- [ ] **Step 4: Remove deprecated architect, daemon, tools, mesh re-exports (lines 141–186)**

Delete:
```typescript
/** @deprecated Use `@gettalon/channels-sdk/architect` instead */
export { createArchitectServer, createAgentMcpServer } from "./architect.js";
...
/** @deprecated Use `@gettalon/channels-sdk/daemon` instead */
export { daemonStart, daemonStop, daemonRestart, daemonStatus } from "./daemon.js";
...
/** @deprecated Use `@gettalon/channels-sdk/tools` instead */
export { launchAgent, ... } from "./tools/agent-launcher.js";
...
/** @deprecated Use `@gettalon/channels-sdk/mesh` instead */
export { deriveMeshId, ... } from "./mesh.js";
...
```

- [ ] **Step 5: Verify the compat package re-exports everything that was removed**

```bash
grep -n "export" packages/channels-sdk/src/index.ts 2>/dev/null | head -40
```

If `packages/channels-sdk/src/index.ts` does not exist or is missing entries, add them there. The compat package must re-export everything that was just removed from the root, so existing consumers don't break.

Check the compat package source:
```bash
ls packages/channels-sdk/src/
cat packages/channels-sdk/src/index.ts 2>/dev/null
```

If the compat package already re-exports from the root (`from "@gettalon/channels-sdk"`), it will pick up whatever the root exports. If not, explicit re-exports are needed.

- [ ] **Step 6: Build and verify**

```bash
npm run build 2>&1 | grep "error" | head -30
```

Expected: no errors. If the compat package or any internal file imported something that was just removed from the root but is still exported from the underlying module, fix those imports to point to the correct subpath or underlying module.

- [ ] **Step 7: Commit**

```bash
git add src/index.ts
git commit -m "refactor(api): narrow root index.ts to stable ChannelServer surface; move deprecated re-exports to compat only"
```

---

## Task 9: Clarify package identity

**Files:**
- Modify: `packages/channels-sdk/package.json`

- [ ] **Step 1: Update compat package description and keywords**

Read current `packages/channels-sdk/package.json`. Find the `"description"` field and update it to clearly state this is a compatibility shim:

```json
"description": "Backwards-compatibility shim for @gettalon/channels-sdk. Consumers should migrate to @gettalon/channels-sdk directly.",
```

Add a `"deprecated"` note in the README or a `"notes"` field if the package.json supports it.

- [ ] **Step 2: Add a `deprecated` field to package.json**

Inside `packages/channels-sdk/package.json`, add:
```json
"_deprecated": "This package is a backwards-compatibility shim. New code should import from @gettalon/channels-sdk directly using subpath exports."
```

- [ ] **Step 3: Verify the root package.json names are clear**

Check `package.json` at root: confirm `"name": "@gettalon/channels-sdk"` and `"version"` are consistent.

```bash
node -e "const p = require('./package.json'); console.log(p.name, p.version)"
node -e "const p = require('./packages/channels-sdk/package.json'); console.log(p.name, p.version)"
```

- [ ] **Step 4: Commit**

```bash
git add packages/channels-sdk/package.json
git commit -m "docs(compat): clarify channels-sdk-compat is a backwards-compatibility shim, not the primary package"
```

---

## Task 10: Add hub-core command interface for state mutations

**Files:**
- Modify: `packages/hub-core/src/hub-facade.ts`

The goal: add explicit command methods that hub-runtime should call instead of directly setting map entries. These become the formal boundary between `hub-core` and `hub-runtime`.

- [ ] **Step 1: Add runtime command methods to `HubFacade`**

In `packages/hub-core/src/hub-facade.ts`, after the `registerPersistentAgentRouter` entry, add a new section before the closing `}`:

```typescript
  // === Runtime Command Interface ===
  // These methods are called exclusively by hub-runtime (hub-server-runtime,
  // hub-client-runtime). They encapsulate all mutations to hub-core state maps
  // so that hub-runtime does not need to reach into core Maps directly.

  /** Register a newly connected agent. */
  registerAgent(id: string, state: import("./types.js").AgentState): void;
  /** Unregister a disconnected agent by ID. */
  unregisterAgent(id: string): void;
  /** Update heartbeat timestamp for an agent. */
  touchAgentHeartbeat(id: string): void;

  /** Add an agent to the pending approval queue. */
  addPendingAgent(code: string, pending: import("./types.js").PendingAgent): void;
  /** Remove an agent from the pending approval queue. */
  removePendingAgent(code: string): void;

  /**
   * Claim ownership of a chat for a specific agent.
   * Distinct from `handover` (which routes between existing agents).
   */
  claimChat(chatId: string, agentId: string): void;

  /** Register a (channelType, rawId) target pair with a stable UUID. */
  registerTarget(name: string, channelType: string, rawId: string, kind: "agent" | "user" | "group" | "channel", sourceUrl?: string): string;
  /** Remove a target entry by UUID. */
  unregisterTarget(uuid: string): void;

  /** Record which channel client owns a chat. */
  registerChannelForChat(chatId: string, client: any): void;
  /** Remove channel-for-chat mapping. */
  unregisterChannelForChat(chatId: string): void;

  /** Register an outbound client connection. */
  registerClient(url: string, client: any): void;
  /** Remove an outbound client connection. */
  unregisterClient(url: string): void;
```

- [ ] **Step 2: Build and verify (interfaces only — no implementation yet)**

```bash
npm run build 2>&1 | grep "error" | head -20
```

Expected: TypeScript errors because `ChannelHub` doesn't implement the new interface methods yet. Note the errors — they indicate what needs implementing in the next task.

- [ ] **Step 3: Commit interface only**

```bash
git add packages/hub-core/src/hub-facade.ts
git commit -m "feat(hub-core): add runtime command interface to HubFacade for explicit state mutation boundary"
```

---

## Task 11: Implement hub-core command methods in `ChannelHub`

**Files:**
- Modify: `src/hub.ts` (the root ChannelHub class)

- [ ] **Step 1: Read `src/hub.ts` to find where to add the implementations**

```bash
grep -n "class ChannelHub\|registerPersistentAgentRouter\|HubState\|this\.state\b" src/hub.ts | head -20
```

Identify where the hub stores its state (likely `this.state: HubState` or direct map fields).

- [ ] **Step 2: Implement `registerAgent` and `unregisterAgent`**

In `src/hub.ts`, add to `ChannelHub`:

```typescript
registerAgent(id: string, state: AgentState): void {
  this.agents.set(id, state);
}

unregisterAgent(id: string): void {
  this.agents.delete(id);
}

touchAgentHeartbeat(id: string): void {
  const agent = this.agents.get(id);
  if (agent) agent.lastHeartbeat = Date.now();
}
```

- [ ] **Step 3: Implement pending agent methods**

```typescript
addPendingAgent(code: string, pending: PendingAgent): void {
  this.pendingAgents.set(code, pending);
}

removePendingAgent(code: string): void {
  this.pendingAgents.delete(code);
}
```

- [ ] **Step 4: Implement `claimChat`**

```typescript
claimChat(chatId: string, agentId: string): void {
  this.chatRoutes.set(chatId, agentId);
}
```

- [ ] **Step 5: Implement target methods**

Check if `registerTarget` already exists on ChannelHub (search with grep):
```bash
grep -n "registerTarget\|unregisterTarget" src/hub.ts src/hub-routing.ts
```

If `registerTarget` already exists as a hub method (likely, since HubRouter calls `hub.registerTarget()`), just confirm it matches the interface. If `unregisterTarget` doesn't exist, add:

```typescript
unregisterTarget(uuid: string): void {
  const entry = this.targetRegistry.get(uuid);
  if (entry) {
    if (this.targetNameIndex.get(entry.name) === uuid) {
      this.targetNameIndex.delete(entry.name);
    }
    this.targetRegistry.delete(uuid);
  }
}
```

- [ ] **Step 6: Implement channel-for-chat and client methods**

```typescript
registerChannelForChat(chatId: string, client: any): void {
  this.channelForChat.set(chatId, client);
}

unregisterChannelForChat(chatId: string): void {
  this.channelForChat.delete(chatId);
}

registerClient(url: string, client: any): void {
  this.clients.set(url, client);
}

unregisterClient(url: string): void {
  this.clients.delete(url);
}
```

- [ ] **Step 7: Build and verify — all errors from Task 10 should now resolve**

```bash
npm run build 2>&1 | grep "error" | head -20
```

Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/hub.ts
git commit -m "feat(hub): implement HubFacade runtime command interface methods"
```

---

## Task 12: Migrate `hub-server-runtime.ts` to use command interface

**Files:**
- Modify: `packages/hub-runtime/src/hub-server-runtime.ts`

- [ ] **Step 1: Replace direct `hub.agents.set()` calls**

Find all occurrences of direct map mutations. From the grep output:

Line ~114:
```typescript
if (now - a.lastHeartbeat > 90000) { a.ws.close(); hub.agents.delete(id); }
```
Replace `hub.agents.delete(id)` with `hub.unregisterAgent(id)`:
```typescript
if (now - a.lastHeartbeat > 90000) { a.ws.close(); hub.unregisterAgent(id); }
```

Line ~288:
```typescript
hub.pendingAgents.set(code, { code, name: agentName, address: addr, tools, ws, metadata, requestedAt: Date.now() });
```
Replace with:
```typescript
hub.addPendingAgent(code, { code, name: agentName, address: addr, tools, ws, metadata, requestedAt: Date.now() });
```

Line ~414:
```typescript
hub.chatRoutes.set(chatId, target.id);
```
Replace with:
```typescript
hub.claimChat(chatId, target.id);
```

Line ~551:
```typescript
hub.agents.delete(ref.id);
```
Replace with:
```typescript
hub.unregisterAgent(ref.id);
```

Lines ~559–560:
```typescript
hub.targetRegistry.delete(ref.id);
if (hub.targetNameIndex.get(entry.name) === ref.id) hub.targetNameIndex.delete(entry.name);
```
Replace with:
```typescript
hub.unregisterTarget(ref.id);
```

Line ~568:
```typescript
if (pa.ws === ws) { hub.pendingAgents.delete(code); break; }
```
Replace with:
```typescript
if (pa.ws === ws) { hub.removePendingAgent(code); break; }
```

Lines ~582, ~586:
```typescript
hub.agents.set(id, { id, name: agentName, tools, ws, lastHeartbeat: Date.now(), address: addr, metadata, ... });
```
Replace both with:
```typescript
hub.registerAgent(id, { id, name: agentName, tools, ws, lastHeartbeat: Date.now(), address: addr, metadata, ... });
```

Line ~682:
```typescript
hub.chatRoutes.set(chatId, id);
```
Replace with:
```typescript
hub.claimChat(chatId, id);
```

- [ ] **Step 2: Verify remaining direct map accesses are reads (not mutations)**

```bash
grep -n "hub\.\(agents\|chatRoutes\|targetRegistry\|targetNameIndex\|pendingAgents\|channelForChat\|groups\|clients\)\." packages/hub-runtime/src/hub-server-runtime.ts | grep -v "\.get\|\.has\|\.size\|\.keys\(\)\|\.values\(\)\|\.entries\(\)\|\.forEach"
```

Expected: no output (all remaining accesses are reads, not mutations).

- [ ] **Step 3: Build and verify**

```bash
npm run build 2>&1 | grep "error" | head -20
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/hub-runtime/src/hub-server-runtime.ts
git commit -m "refactor(hub-server-runtime): use HubFacade command methods instead of direct state map mutations"
```

---

## Task 13: Migrate `hub-client-runtime.ts` to use command interface

**Files:**
- Modify: `packages/hub-runtime/src/hub-client-runtime.ts`

- [ ] **Step 1: Replace direct `hub.channelForChat.set()` calls**

Lines ~246, ~250:
```typescript
hub.channelForChat.set(uuid, client);
hub.channelForChat.set(rawChatId, client);
```
Replace with:
```typescript
hub.registerChannelForChat(uuid, client);
hub.registerChannelForChat(rawChatId, client);
```

- [ ] **Step 2: Replace direct `hub.clients.set()` call**

Line ~292:
```typescript
hub.clients.set(storeUrl, {
```
Replace with:
```typescript
hub.registerClient(storeUrl, {
```

- [ ] **Step 3: Check for other direct map mutations and replace**

```bash
grep -n "hub\.\(agents\|chatRoutes\|targetRegistry\|targetNameIndex\|pendingAgents\|channelForChat\|groups\|clients\)\.(set\|delete\|clear)" packages/hub-runtime/src/hub-client-runtime.ts
```

For each mutation found, use the appropriate command method from Task 10.

- [ ] **Step 4: Verify remaining accesses are reads only**

```bash
grep -n "hub\.\(agents\|chatRoutes\|targetRegistry\|targetNameIndex\|pendingAgents\|channelForChat\|groups\|clients\)\." packages/hub-runtime/src/hub-client-runtime.ts | grep -v "\.get\|\.has\|\.size\|\.keys\(\)\|\.values\(\)\|\.entries\(\)\|\.forEach"
```

Expected: no output.

- [ ] **Step 5: Build and verify — full build should be clean**

```bash
npm run build 2>&1 | grep "error" | head -20
```

Expected: no errors.

- [ ] **Step 6: Run tests if any exist**

```bash
npm test 2>&1 | tail -20
```

- [ ] **Step 7: Commit**

```bash
git add packages/hub-runtime/src/hub-client-runtime.ts
git commit -m "refactor(hub-client-runtime): use HubFacade command methods instead of direct state map mutations"
```

---

## Self-Review Checklist

### Spec Coverage

| Fix from REMAINING_FIXES.md | Task(s) |
|---|---|
| 1. process.env reads in active runtime modules | Tasks 1–6 |
| 2. Conservative network defaults | Task 7 |
| 3. Root package API too broad | Task 8 |
| 4. Package identity muddled | Task 9 |
| 5. hub-runtime reaches into hub-core internals | Tasks 10–13 |

### Type Consistency

- `AgentState` and `PendingAgent` types imported from `@gettalon/hub-core` throughout — check that `hub-server-runtime.ts` uses the same type shapes when calling `hub.registerAgent()` and `hub.addPendingAgent()`.
- `hub.claimChat(chatId, agentId)` — both args are `string`.
- `hub.unregisterTarget(uuid)` — single `string` arg.
- `hub.registerChannelForChat(chatId, client)` — `client` is `any` for now (matches existing map type).

### Placeholder Scan

- Task 7 Step 2: verify the `cfg?.host` variable name matches what's in scope in `src/channels/websocket.ts` near line 887 before implementing.
- Task 8 Step 5: the compat package content must be verified before removing from root — do not remove from root if the compat package doesn't already cover it.
- Task 11: grep for `registerTarget` before assuming it exists on ChannelHub.
