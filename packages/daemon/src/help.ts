/** Side-effect-free global, nested-command, and version help. */
import { daemonVersion } from "./version.js";

const HELP_BODY = ` connects this machine to a Pievo server and runs scheduled prompts locally.

Usage: pievo [command] [options]

  pievo                   Show this machine's loops and recent runs.

Install and daemon lifecycle
  npm install -g @kky42/pievo@latest
  daemon connect --server-url <url> [--connect-key <dk_…>]
                          Save/select a server and ensure its daemon is running.
  daemon connections      List saved servers; * marks the active server.
  daemon start [--foreground]
                          Start the active connection; --foreground runs attached.
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
  daemon: "pievo daemon <connect|connections|start|stop|restart|status>\n  Manage this machine's Pievo daemon and saved server connections.",
  "daemon connect": `pievo daemon connect --server-url <url> [--connect-key <dk_…>]
  Save or select a server, start its daemon if needed, and wait until it is online.
  A first connection needs a connect key. Saved connections reuse their device identity.
  Treat connect keys as secrets; follow the printed log path when connection fails.`,
  "daemon connections": "pievo daemon connections\n  List saved servers; * marks the active server.",
  "daemon start": "pievo daemon start [--foreground]\n  Start the active connection detached by default, or attached with --foreground.",
  "daemon stop": "pievo daemon stop [--force]\n  Default waits for terminal-report durability; --force bounds the wait and may leave the last result uncertain.",
  "daemon restart": "pievo daemon restart [--force]\n  Stop then start the currently installed version. --force has the same durability risk as daemon stop.",
  "daemon status": "pievo daemon status\n  Show local daemon, server connectivity, run, and report diagnostics.",
  new: `pievo new --json '<config>' [--dry-run] [--connect-key <dk_…>] [--server-url <url>]
  Use --json - to read the config from stdin.

Canonical config
  Required:
    name                non-empty string
    schedule            one complete schedule:
      mode: cron        cron, IANA timezone, overlap: skip|queue-one
      mode: continuous  delayMinutes (integer >= 1)
    workdir             absolute path on this machine
    agent               claude-code|codex
    prompt              non-empty string, stored unchanged
    statusDefinitions   non-empty keep, noChange, block strings
  Optional:
    model, reasoningEffort  string or null for the provider default
    artifacts              exact workdir-relative file paths; default []
    enabled                boolean; default true

  Cron and continuous fields cannot be mixed. Artifact paths are explicit uploads,
  not globs or directories; missing files are skipped and files over 10 MB are
  metadata-only. Top-level and nested unknown fields are rejected. Use --dry-run to
  validate and preview the normalized config without creating it.`,
  skill: "pievo skill [status|install]\n  Install or inspect the owner-facing Pievo skill.",
  pause: "pievo pause <loop>\n  Pause future runs; the current run continues.",
  start: "pievo start <loop>\n  Enable a paused loop and re-arm its existing schedule; preserved queued work becomes eligible immediately.",
  stop: `pievo stop <loop>
  Pause the loop, cancel queued work, and request current-run termination.
  A running run remains running until the daemon confirms cancellation.`,
  delete: `pievo delete <loop> [--force]
  Stop first, then delete server history and synced artifact metadata.
  Local project files are never deleted. --force requires a prior Delete request,
  team-owner authority, and explicit local confirmation; it may retire server
  authority while a local process is still running.`,
  run: "pievo run stop <run>\n  Stop one pending or running run without pausing its loop. A running run changes state only after daemon confirmation.",
  log: "pievo log [<loop>] [--limit 1..20] [--status keep|no-change|block] [--phase done|error|canceled] [--run <index|UUID> [--diff]] [--json]\n  Show bounded run history or detail. <loop> defaults from the current workdir.",
  show: "pievo show [<loop>] [--full] [--json]\n  Show canonical config and recent runs. For an edit, select only changed fields from --json; id is read-only.",
  loops: "pievo loops [--fields a,b] [--json]\n  List loops on this machine.",
  edit: `pievo edit <loop> --json '<patch>' [--dry-run]
  Inspect first with: pievo show <loop> --json

  Accepted fields: name, schedule, workdir, agent, model, reasoningEffort, prompt,
  statusDefinitions, artifacts, enabled. Unknown fields are rejected.
  The patch changes only supplied fields, except schedule and statusDefinitions each
  require a complete replacement value. Use null for the provider-default model or
  reasoning effort. Use --dry-run to preview normalized before/after values without
  changing the loop.`,
  report: `pievo report --status keep|no-change|block --message <text>
  In-run only. Record one required outcome exactly once; status and a non-empty
  message are required. Owner loop-management commands are unavailable inside a run.`,
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
