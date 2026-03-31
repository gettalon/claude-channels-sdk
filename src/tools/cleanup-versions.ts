/**
 * cleanup-versions tool — Remove old cached plugin versions.
 */
import type { ToolDefinition } from "./types.js";
import { cleanupStaleVersions } from "./agent-launcher.js";

export const cleanupVersionsTool: ToolDefinition = {
  name: "cleanup_versions",
  description: "Remove old cached plugin versions, keeping only the latest",
  inputSchema: { type: "object", properties: {}, required: [] },
  handle: async () => {
    const result = cleanupStaleVersions();
    if (result.removed.length === 0) {
      return JSON.stringify({ ok: true, message: `No stale versions found. Current: ${result.kept || "none"}` });
    }
    return JSON.stringify({ ok: true, kept: result.kept, removed: result.removed });
  },
};
