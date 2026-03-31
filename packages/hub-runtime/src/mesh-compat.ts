/**
 * mesh-compat.ts — Stub for E2E session and identity functions.
 *
 * At runtime, the root package (@gettalon/channels-sdk) provides the real
 * implementations via dynamic import. This stub exists so the package
 * compiles independently without circular dependencies.
 *
 * The runtime files that import this use try/catch around all calls,
 * so if these stubs are reached they fail gracefully.
 */

export class E2eSession {
  static fromKeyExchange(_privateKey: string, _publicKey: string, _name: string): E2eSession {
    throw new Error("E2eSession not available — mesh module not loaded");
  }
  encrypt(_data: string): string { throw new Error("E2eSession not available"); }
  decrypt(_data: string): string { throw new Error("E2eSession not available"); }
}

export async function loadOrCreateIdentity(_dir: string): Promise<{ publicKey: string; privateKey: string }> {
  throw new Error("loadOrCreateIdentity not available — mesh module not loaded");
}
