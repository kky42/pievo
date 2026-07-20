/** Side-effect-free global, nested-command, and version help. */
import { daemonVersion } from "./version.js";

const HELP_BODY = ` connects this machine to a Pievo server and runs scheduled agent loops locally.

Usage: pievo [command] [options]

  pievo                   Show this machine's loops and recent runs.

Install and daemon lifecycle
  npm install -g @kky42/pievo@latest
  daemon start [--foreground] [--server-url <url>] [--connect-key <dk_…>]
                          Start detached by default; idempotent. --foreground runs
                          attached and also supports first connection.
  daemon stop [--force]   Stop the daemon. --force bounds the durability wait.
  daemon restart [--force]
                          Stop then start the currently installed version. --force
                          applies only to stop. Upgrade npm first when desired.
  daemon status           Show local daemon and connection diagnostics.

Loop setup and management
  new --json '<config>' [--dry-run]
                          Create a loop (--json - reads stdin).
  skill [status|install] [--project]
                          Manage the Pievo agent skill installation.
  pause <loop>            Pause future runs; the current run continues.
  start <loop>            Start a paused loop using its existing cadence.
  stop <loop>             Pause, cancel queued work, and request run termination.
  delete <loop> [--force] Stop first, then delete server history and synced metadata.
  run stop <run>          Stop one run without pausing its loop.
  show [<id>]             Show a loop's editable config and recent state.
  log [<loop>]            Show recent runs (--json, --limit N).
  loops [--fields a,b] [--json]
                          List loops on this machine.
  edit <id> --json '<obj>' [--dry-run]
                          Edit a loop; content-file flags are also supported.

Upgrade
  npm install -g @kky42/pievo@latest
  pievo daemon restart

  -h, --help              Show this help.
  -v, --version           Print the daemon version and exit.
`;

const VERB_USAGE: Record<string, string> = {
  daemon: "pievo daemon <start|stop|restart|status>\n  Manage this machine's Pievo daemon.",
  "daemon start": "pievo daemon start [--foreground] [--server-url <url>] [--connect-key <dk_…>]\n  Start detached by default (idempotent), or run attached with --foreground.",
  "daemon stop": "pievo daemon stop [--force]\n  Stop the daemon. Default waits for terminal-report durability; --force bounds the wait.",
  "daemon restart": "pievo daemon restart [--force]\n  Stop then start the currently installed version. --force applies only to stop.",
  "daemon status": "pievo daemon status\n  Show local daemon, server connectivity, run, and report diagnostics.",
  new: "pievo new --json '<config>' [--dry-run]\n  Create a loop (--json - reads stdin); --dry-run validates without persistence.",
  skill: "pievo skill [status|install] [--project]\n  Manage the Pievo agent skill installation.",
  pause: "pievo pause <loop>\n  Pause future runs. The current run continues.",
  start: "pievo start <loop>\n  Start a paused loop and re-arm its cadence.",
  stop: "pievo stop <loop>\n  Pause the loop, cancel queued work, and request current-run termination.",
  delete: "pievo delete <loop> [--force]\n  Stop then delete server history and synced metadata; local project files remain.",
  run: "pievo run stop <run>\n  Stop one pending or running run without pausing its loop.",
  log: "pievo log [<loop>] [--json] [--limit N]\n  Show recent runs. Defaults to the loop for the current directory.",
  show: "pievo show [<id>] [--full] [--json]\n  Show a loop's editable config and recent state.",
  loops: "pievo loops [--fields a,b] [--json]\n  List loops on this machine.",
  edit: "pievo edit <id> --json '<obj>' [--dry-run] [content-file flags]\n  Edit a loop; --dry-run previews before/after.",
  report: "pievo report ...\n  In-run only: record this run's result.",
  finish: "pievo finish ...\n  In-run only: mark a closed loop's goal met.",
  complete: "pievo complete ...\n  In-run only alias of finish.",
};

function versionLabel(version: string | undefined): string {
  return version ? `pievo v${version}` : "pievo";
}

export function printVerbHelp(verb: string, out: (s: string) => void = (s) => process.stdout.write(s), version: string | undefined = daemonVersion()): number {
  const usage = VERB_USAGE[verb];
  if (!usage) return printHelp(out, version);
  out(`${versionLabel(version)}\n\n${usage}\n\nRun \`pievo --help\` for all commands.\n`);
  return 0;
}

export function printHelp(out: (s: string) => void = (s) => process.stdout.write(s), version: string | undefined = daemonVersion()): number {
  out(`${versionLabel(version)} - the Pievo daemon:${HELP_BODY}`);
  return 0;
}

export function printVersion(out: (s: string) => void = (s) => process.stdout.write(s), version: string | undefined = daemonVersion()): number {
  out(`${version ? `pievo v${version}` : "pievo (version unknown)"}\n`);
  return 0;
}
