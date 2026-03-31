/**
 * hub-hooks.ts — Programmatic + shell hooks for ChannelHub lifecycle events.
 * Extracted from hub.ts (lines 327–415).
 */
import { exec } from "node:child_process";
import type { ChannelHub } from "./hub.js";
import type { HubHookEvent, HubHookFn } from "./hub.js";

/** Install hook methods onto the ChannelHub prototype. */
export function installHooks(Hub: typeof ChannelHub): void {

  /**
   * Register a hook function for a lifecycle event.
   * Hooks are invoked in registration order when the event fires.
   */
  Hub.prototype.hook = function(this: ChannelHub, event: HubHookEvent, fn: HubHookFn): ChannelHub {
    const list = (this as any).hookRegistry.get(event);
    if (list) list.push(fn);
    else (this as any).hookRegistry.set(event, [fn]);
    return this;
  };

  /**
   * Register a shell command hook.
   * The command is executed via child_process.exec when the event fires,
   * and persisted to settings.json under the "hooks" key.
   */
  Hub.prototype.addShellHook = async function(this: ChannelHub, event: HubHookEvent, command: string): Promise<void> {
    (this as any).shellHooks.push({ event, command });
    // Persist to settings.json
    const settings = await this.loadSettings();
    const existing = settings.hooks ?? [];
    existing.push({ event, command });
    settings.hooks = existing;
    await this.saveSettings(settings);
    process.stderr.write(`[${this.name}] Shell hook registered: ${event} -> ${command}\n`);
  };

  /**
   * Load shell command hooks from settings.json into memory.
   * Called during autoSetup to hydrate persisted hooks.
   */
  (Hub.prototype as any).loadShellHooks = async function(this: ChannelHub): Promise<void> {
    const settings = await this.loadSettings();
    if (settings.hooks?.length) {
      for (const h of settings.hooks) {
        // Avoid duplicates if already loaded
        const exists = (this as any).shellHooks.some((s: any) => s.event === h.event && s.command === h.command);
        if (!exists) {
          (this as any).shellHooks.push({ event: h.event as HubHookEvent, command: h.command });
        }
      }
      process.stderr.write(`[${this.name}] Loaded ${(this as any).shellHooks.length} shell hook(s) from settings\n`);
    }
  };

  /**
   * Fire all hooks (programmatic + shell commands) for a given event.
   * Errors in individual hooks are logged but do not propagate.
   */
  (Hub.prototype as any).fireHooks = async function(this: ChannelHub, event: HubHookEvent, ...args: any[]): Promise<void> {
    // Global hooks toggle — skip all hooks when disabled
    if ((this as any)._hooksEnabled === false) return;
    // Programmatic hooks
    const fns = (this as any).hookRegistry.get(event);
    if (fns) {
      for (const fn of fns) {
        try { await fn(...args); }
        catch (e) { process.stderr.write(`[${this.name}] Hook error (${event}): ${e}\n`); }
      }
    }
    // Shell command hooks
    for (const sh of (this as any).shellHooks) {
      if (sh.event === event) {
        await (this as any).execShellHook(sh.command, event, args);
      }
    }
  };

  /**
   * Execute a shell command hook with environment variables describing the event.
   */
  (Hub.prototype as any).execShellHook = function(this: ChannelHub, command: string, event: string, args: any[]): Promise<void> {
    return new Promise((resolve) => {
      const env = {
        ...process.env,
        TALON_HOOK_EVENT: event,
        TALON_HOOK_DATA: JSON.stringify(args.length === 1 ? args[0] : args),
        TALON_HUB_NAME: this.name,
      };
      exec(command, { env, timeout: 30_000 }, (err, stdout, stderr) => {
        if (err) {
          process.stderr.write(`[${this.name}] Shell hook failed (${event}): ${err.message}\n`);
        }
        if (stdout) process.stderr.write(`[${this.name}] Hook stdout (${event}): ${stdout.trim()}\n`);
        if (stderr) process.stderr.write(`[${this.name}] Hook stderr (${event}): ${stderr.trim()}\n`);
        resolve();
      });
    });
  };
}
