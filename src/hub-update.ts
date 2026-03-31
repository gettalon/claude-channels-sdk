/**
 * hub-update.ts — Version check and auto-update for the SDK.
 * Extracted from hub.ts (lines 226–325).
 */
import { readFile } from "node:fs/promises";
import { exec } from "node:child_process";
import type { ChannelHub, UpdateInfo } from "./hub.js";

/** Install version/update methods onto the ChannelHub prototype. */
export function installUpdate(Hub: typeof ChannelHub): void {

  /**
   * Read the SDK version from the nearest package.json.
   * Works whether the SDK is installed in node_modules or run from source.
   */
  Hub.getVersion = function(): string {
    try {
      // import.meta.url points to the compiled JS; walk up to find package.json
      const { readFileSync } = require("node:fs");
      const { join, dirname } = require("node:path");
      // Try dist/../package.json (source/dev layout) then walk up
      let dir = __dirname ?? dirname(new URL(import.meta.url).pathname);
      for (let i = 0; i < 5; i++) {
        try {
          const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"));
          if (pkg.name === "@gettalon/channels-sdk") return pkg.version as string;
        } catch { /* keep walking */ }
        dir = dirname(dir);
      }
    } catch { /* fallback */ }
    return "unknown";
  };

  /**
   * Check the npm registry for the latest published version and compare
   * it with the currently installed version.
   */
  Hub.prototype.checkForUpdates = async function(this: ChannelHub): Promise<UpdateInfo> {
    const currentVersion = Hub.getVersion();
    let latestVersion = currentVersion;

    // 1. Try git tags (primary — works for private repos)
    try {
      const { execSync } = await import("node:child_process");
      const { dirname, join: pathJoin } = await import("node:path");
      let dir = __dirname ?? dirname(new URL(import.meta.url).pathname);
      for (let i = 0; i < 5; i++) {
        try {
          const raw = await readFile(pathJoin(dir, "package.json"), "utf-8");
          if (JSON.parse(raw).name === "@gettalon/channels-sdk") {
            // Fetch latest tags from remote
            execSync("git fetch --tags 2>/dev/null", { cwd: dir, timeout: 10000 });
            const tags = execSync("git tag -l 'v*' --sort=-v:refname", { cwd: dir, encoding: "utf-8", timeout: 5000 }).trim();
            const latest = tags.split("\n")[0]?.replace(/^v/, "");
            if (latest) { latestVersion = latest; break; }
          }
        } catch {}
        dir = dirname(dir);
      }
    } catch {}

    // 2. Fallback: npm registry
    if (latestVersion === currentVersion) {
      try {
        const res = await fetch("https://registry.npmjs.org/@gettalon/channels-sdk/latest");
        if (res.ok) {
          const data = (await res.json()) as { version?: string };
          if (data.version) latestVersion = data.version;
        }
      } catch {}
    }

    const updateAvailable = latestVersion !== currentVersion && currentVersion !== "unknown";
    return { currentVersion, latestVersion, updateAvailable };
  };

  /**
   * If a newer version is available on npm, run `npm update` inside the
   * plugin cache directory that contains this SDK. Emits an "updated" event
   * on success with the old and new versions.
   */
  Hub.prototype.autoUpdate = async function(this: ChannelHub): Promise<UpdateInfo & { updated: boolean }> {
    const info = await this.checkForUpdates();
    if (!info.updateAvailable) return { ...info, updated: false };

    process.stderr.write(`[${this.name}] Update available: ${info.currentVersion} -> ${info.latestVersion}, updating...\n`);

    // Resolve the directory that contains this SDK installation
    const { dirname, join: pathJoin } = await import("node:path");
    let installDir: string | null = null;
    try {
      let dir = __dirname ?? dirname(new URL(import.meta.url).pathname);
      for (let i = 0; i < 5; i++) {
        try {
          const raw = await readFile(pathJoin(dir, "package.json"), "utf-8");
          const pkg = JSON.parse(raw);
          if (pkg.name === "@gettalon/channels-sdk") { installDir = dir; break; }
        } catch { /* keep walking */ }
        dir = dirname(dir);
      }
    } catch { /* fallback */ }

    if (!installDir) {
      process.stderr.write(`[${this.name}] Could not locate SDK install directory for update\n`);
      return { ...info, updated: false };
    }

    // The npm update should run in the parent project (the directory that has
    // node_modules/@gettalon/channels-sdk). Walk up from installDir past
    // node_modules/@gettalon/channels-sdk to find the project root.
    let projectDir = installDir;
    const segments = projectDir.split("/");
    const nmIdx = segments.lastIndexOf("node_modules");
    if (nmIdx > 0) {
      projectDir = segments.slice(0, nmIdx).join("/");
    }

    // Try git pull first (for git-based installs), then npm update as fallback
    return new Promise((resolve) => {
      // Check if installDir is a git repo
      exec("git rev-parse --is-inside-work-tree", { cwd: installDir!, timeout: 5000 }, (gitErr) => {
        if (!gitErr) {
          // Git repo — pull latest + rebuild
          exec(`git pull origin main && npm run build 2>/dev/null`, { cwd: installDir!, timeout: 120_000 }, (err, stdout, stderr) => {
            if (err) {
              process.stderr.write(`[${this.name}] git pull failed: ${err.message}\n`);
              resolve({ ...info, updated: false });
              return;
            }
            process.stderr.write(`[${this.name}] Updated via git pull to ${info.latestVersion}\n`);
            this.emit("updated", { from: info.currentVersion, to: info.latestVersion });
            // Hot-reload after update
            this.reload().catch(() => {});
            resolve({ ...info, updated: true });
          });
        } else {
          // Not a git repo — use npm update
          exec("npm update @gettalon/channels-sdk", { cwd: projectDir, timeout: 120_000 }, (err, stdout) => {
            if (err) {
              process.stderr.write(`[${this.name}] npm update failed: ${err.message}\n`);
              resolve({ ...info, updated: false });
              return;
            }
            process.stderr.write(`[${this.name}] Updated via npm to ${info.latestVersion}\n`);
            this.emit("updated", { from: info.currentVersion, to: info.latestVersion });
            this.reload().catch(() => {});
            resolve({ ...info, updated: true });
          });
        }
      });
    });
  };
}
