/**
 * Subpath entry: @gettalon/channels-sdk/daemon
 *
 * Run ChannelHub as a background daemon process.
 */

export {
  daemonStart,
  daemonStop,
  daemonRestart,
  daemonStatus,
  daemonEnable,
  daemonDisable,
} from "../daemon.js";

export type {
  DaemonStatus,
  DaemonStartResult,
} from "../daemon.js";
