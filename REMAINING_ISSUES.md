# Remaining Issues — blueprint-remaining-fixes

## VM Channels Not Available

**Root cause:** Claude Code channels are gated behind `tengu_harbor` GrowthBook feature flag.
The flag is only enabled for authenticated accounts via the live GrowthBook fetch at startup.

**On the VM (`edge-agent-vm`):**
- `CLAUDE_CODE_OAUTH_TOKEN` is set in `~/.claude/settings.json` env
- `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` is also set
- But the OAuth token copied from local `config.json` is **expired** (2025-07-05)
- GrowthBook fetch fails or returns `tengu_harbor: false` → "Channels are not currently available"

**To fix:**
1. Get a fresh token: `orb -m edge-agent-vm claude login` (interactive browser login)
2. Or: refresh the token via `CLAUDE_CODE_OAUTH_REFRESH_TOKEN` + `CLAUDE_CODE_OAUTH_SCOPES`:
   ```bash
   CLAUDE_CODE_OAUTH_REFRESH_TOKEN="<refresh_token from config.json>" \
   CLAUDE_CODE_OAUTH_SCOPES="user:inference user:profile" \
   claude auth login
   ```
3. Or: wait for Anthropic to make `tengu_harbor` available without login requirement

**Alternative workaround:** Use `ANTHROPIC_API_KEY` on the VM — channels may not require OAuth
specifically, but GrowthBook still needs it for `tengu_harbor`.

**Where token is stored on Linux:** `~/.claude/.credentials.json` under key `claudeAiOauth`

---

## Mac→VM Send Routing (fixed in beta.5/beta.6)

- **Fixed:** `sendMessage` was routing to Telegram before trying hub peers
- **Fixed:** Blind channel fallback removed — now returns `{ ok: false, error: "No route" }` instead

## start_server host param (fixed in beta.4)

- **Fixed:** `start_server` tool now accepts `host` parameter (default `127.0.0.1`)
- Use `host: "0.0.0.0"` to bind to all interfaces
