/**
 * agent-config-compat.ts — Stub for agent config loading.
 *
 * At runtime, the root package provides the real implementation.
 * This stub exists so the package compiles independently.
 * The runtime file uses try/catch around the dynamic import.
 */

export async function loadAgentConfig(_id: string, _dir?: string): Promise<any> {
  return null;
}
