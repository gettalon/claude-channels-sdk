/**
 * Global test setup — isolate all tests from production ~/.talon.
 * Sets TALON_HOME to a temp dir and configures hub-settings to use it.
 */
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setSettingsPath } from "../dist/hub-settings.js";

let testTalonHome: string;

export async function setup() {
  testTalonHome = await mkdtemp(join(tmpdir(), "talon-test-home-"));
  await mkdir(join(testTalonHome, "agents"), { recursive: true });
  process.env.TALON_HOME = testTalonHome;
  setSettingsPath(join(testTalonHome, "settings.json"));
}

export async function teardown() {
  await rm(testTalonHome, { recursive: true, force: true }).catch(() => {});
  delete process.env.TALON_HOME;
}
