#!/usr/bin/env node
/**
 * Postinstall hint — shown after npm install.
 * Non-interactive so it works in CI.
 */

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

process.stderr.write("\n");
process.stderr.write(bold("  @gettalon/channels-sdk") + " installed\n");
process.stderr.write("\n");
process.stderr.write(`  Run ${cyan("claude-channels setup")} to configure Claude Code.\n`);
process.stderr.write(dim("  Or: npx @gettalon/channels-sdk setup\n"));
process.stderr.write("\n");
