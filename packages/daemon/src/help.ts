/** Side-effect-free global, nested-command, and version help. */
import { daemonVersion } from "./version.js";

const HELP_BODY = ` connects this machine to a Pievo server and runs scheduled prompts locally.

Usage: pievo [command] [options]

  pievo                   Show this machine's loops and recent runs.

Install and daemon lifecycle
  npm install -g @kky42/pievo@latest
  daemon start [--foreground] [--server-url <url>] [--connect-key <dk_…>]
                          Start detached by default; --foreground runs attached.
  daemon stop [--force]   Stop the daemon. --force bounds the durability wait.
  daemon restart [--force]
  daemon status           Show local daemon and connection diagnostics.

Loop setup and management
  new --json '<config>' [--dry-run]
                          Create from the canonical config envelope (--json - reads stdin).
                          Required: name, schedule, workdir, agent, prompt,
                          statusDefinitions. Optional: model, reasoningEffort,
                          artifacts, enabled, connect/server overrides.
  pause <loop>            Pause future runs; the current run continues.
  start <loop>            Start a paused loop using its existing schedule.
  stop <loop>             Pause, cancel queued work, and request run termination.
  delete <loop> [--force] Stop first, then delete server history and artifacts.
  run stop <run>          Stop one run without pausing its loop.
  show [<loop>]           Show editable config and recent runs (--full, --json).
  log [<loop>]            Show recent runs (--json, --limit N).
  loops [--fields a,b] [--json]
  edit <loop> --json '<patch>' [--dry-run]
                          Patch schedule/prompt/status/artifact/provider config.
  skill [status|install]  Install or inspect the owner-facing Pievo skill.

In-run report
  report --status keep|no-change|block --message <text>
                          Record the required outcome exactly once.

Upgrade
  npm install -g @kky42/pievo@latest
  pievo daemon restart

  -h, --help              Show this help.
  -v, --version           Print the daemon version and exit.
`;

const VERB_USAGE: Record<string, string> = {
  daemon: "pievo daemon <start|stop|restart|status>\n  Manage this machine's Pievo daemon.",
  "daemon start": "pievo daemon start [--foreground] [--server-url <url>] [--connect-key <dk_…>]\n  Start detached by default, or attached with --foreground.",
  "daemon stop": "pievo daemon stop [--force]\n  Default waits for terminal-report durability; --force bounds the wait.",
  "daemon restart": "pievo daemon restart [--force]\n  Stop then start the currently installed version.",
  "daemon status": "pievo daemon status\n  Show local daemon, server connectivity, run, and report diagnostics.",
  new: "pievo new --json '<config>' [--dry-run] [--connect-key <dk_…>] [--server-url <url>]\n  Create a loop from the canonical envelope. Cron schedule: {mode,cron,timezone,overlap}; continuous: {mode,delayMinutes}. agent is required.",
  skill: "pievo skill [status|install]\n  Install or inspect the owner-facing Pievo skill.",
  pause: "pievo pause <loop>\n  Pause future runs. The current run continues.",
  start: "pievo start <loop>\n  Start a paused loop and re-arm its schedule.",
  stop: "pievo stop <loop>\n  Pause the loop, cancel queued work, and request current-run termination.",
  delete: "pievo delete <loop> [--force]\n  Stop then delete server history and synced artifact metadata; local files remain.",
  run: "pievo run stop <run>\n  Stop one pending or running run without pausing its loop.",
  log: "pievo log [<loop>] [--limit 1..20] [--status keep|no-change|block] [--phase done|error|canceled] [--run <index|UUID> [--diff]] [--json]\n  Show bounded run history or detail. <loop> defaults from the current workdir.",
  show: "pievo show [<loop>] [--full] [--json]\n  Show the editable config envelope and recent runs.",
  loops: "pievo loops [--fields a,b] [--json]\n  List loops on this machine.",
  edit: "pievo edit <loop> --json '<patch>' [--dry-run]\n  Patch name/schedule/workdir/agent/model/reasoningEffort/prompt/statusDefinitions/artifacts/enabled.",
  report: "pievo report --status keep|no-change|block --message <text>\n  In-run only: both status and a non-empty message are required.",
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
