/**
 * Claude Channels SDK — Types
 *
 * Complete type definitions for Claude Code channels + all 23 hook events.
 * Generic — not tied to any specific client (browser, Telegram, etc.).
 */
/** Events that can block (exit code 2 or decision:"block") */
export const BLOCKING_EVENTS = new Set([
    "PreToolUse",
    "PermissionRequest",
    "UserPromptSubmit",
    "Stop",
    "SubagentStop",
    "TeammateIdle",
    "TaskCompleted",
    "ConfigChange",
    "Elicitation",
    "ElicitationResult",
    "WorktreeCreate",
]);
//# sourceMappingURL=types.js.map