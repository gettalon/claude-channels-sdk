/**
 * transports-compat.ts — Stub for transport registration side-effect.
 *
 * At runtime, the root package registers built-in transports before
 * hub-client-runtime calls createChannel(). This stub is a no-op
 * so the package compiles independently.
 */
export {};
// No-op — transports are registered by the root package at startup.
//# sourceMappingURL=transports-compat.js.map