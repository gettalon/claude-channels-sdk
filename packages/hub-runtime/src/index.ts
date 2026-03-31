// @gettalon/hub-runtime — Server/client runtimes, config, settings, health, hooks, daemon

// Runtime classes
export { HubServerRuntime } from "./hub-server-runtime.js";
export { HubClientRuntime } from "./hub-client-runtime.js";

// Config service
export { HubConfigService, type TalonConfig } from "./hub-config-service.js";

// Settings (load, save, lock, registries, state persistence)
export {
  getTalonHome,
  setSettingsPath,
  getSettingsPath,
  acquireLock,
  releaseLock,
  loadSettings,
  loadSettingsSafe,
  saveSettings,
  registerServer,
  unregisterServer,
  getRegisteredServers,
  addConnection,
  removeConnection,
  getConnections,
  installSettings,
} from "./hub-settings.js";

// Health monitor
export { installHealth } from "./hub-health.js";

// Hooks system
export { installHooks } from "./hub-hooks.js";

// Daemon lifecycle
export {
  daemonStart,
  daemonStop,
  daemonRestart,
  daemonStatus,
  daemonEnable,
  daemonDisable,
  type DaemonStatus,
  type DaemonStartResult,
} from "./daemon.js";
