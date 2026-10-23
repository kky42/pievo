import { daemonVersion } from "./version.js";

const HELP_BODY = ` runs scheduled coding-agent prompts across your devices.

Usage: pievo [command] [options]

  pievo                   Show this machine's loops and recent runs.

Server (on the device that hosts the dashboard)
  npm install -g @kky42/pievo@latest
  server start [--foreground] [--port <n>] [--no-https]
                          Serve the dashboard to this machine, your LAN, and Tailscale.
  server status           Show the server process and every URL it is reachable at.
  server stop | server restart
                          See \`pievo server --help\` for all options.

Daemon (on every device that runs loops)
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
                          Required: name, schedule, workdir, agent, prompt.
                          Optional: tags, model, reasoningEffort, artifacts, enabled.
  pause <loop>            Pause future runs; the current run continues.
  start <loop>            Start a paused loop using its existing schedule.
  stop <loop>             Pause, cancel queued work, and request run termination.
  delete <loop> [--force] Stop first, then delete server history, memory, and artifacts.
  run stop <run>          Stop one run without pausing its loop.
  show [<loop>]           Show editable config and recent runs (--full, --json).
  log [<loop>]            Show recent runs (--json, --limit N).
  loops [--fields a,b] [--json]
  edit <loop> --json '<patch>' [--dry-run]
                          Patch (--json - reads stdin) tags/schedule/prompt/artifact/provider config.
  skill [status|install]  Install or inspect the bundled owner-facing Pievo skill.
                          Install overwrites same-named user Pievo skills.

  file list <loop>        List the loop's MEMORY.md and artifact files.
  file get <loop> <name>  Print one loop file.
  file set <loop> <name> --from <path|->
                          Replace one loop file (wins over an in-progress run's edit).

Inside a run
  pievo commands are unavailable. Runs edit loop files in $PIEVO_LOOP_DIR and end
  their final response with an optional \`ATTENTION: <reason>\` line and a last
  line \`STATUS: ok|block\`; block pauses the loop.

Upgrade
  npm install -g @kky42/pievo@latest
  pievo daemon restart    (and \`pievo server restart\` on the server device)

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
  new: `pievo new --json '<config>' [--dry-run]
  Use --json - to read the config from stdin.

Canonical config
  Required:
    name                non-empty string
    schedule            one complete schedule:
      mode: cron        cron, IANA timezone, overlap: skip|queue-one
      mode: continuous  delayMinutes (integer >= 1)
    workdir             absolute path on this machine
    agent               claude-code|codex|pi
    prompt              non-empty string, stored unchanged
  Optional:
    tags                   up to 4 strings, 64 characters each; default []
                           NFKC lowercase with collapsed whitespace, then sorted;
                           no duplicates, invisible/control characters, or
                           all loops|active|paused|blocked
    model, reasoningEffort string or null for the provider default
                           Pi thinking: off|minimal|low|medium|high|xhigh|max
    artifacts              up to 4 text/code file names (256 KB each); default []
                           .md renders as Markdown, .html in a sandboxed frame,
                           .svg as an image, other text/code as source
    enabled                boolean; default true

  Cron and continuous fields cannot be mixed. Every loop also has MEMORY.md (8000
  characters), its memory across runs. Runs edit these files in a private directory
  and the dashboard renders them; they are not workdir files. Top-level and nested unknown fields are rejected. Use --dry-run to
  validate and preview the normalized config without creating it.`,
  skill: "pievo skill [status|install]\n  Install or inspect the bundled owner-facing Pievo skill. Install copies the current CLI bundle to the Claude and universal agent user directories, overwriting same-named Pievo skills.",
  pause: "pievo pause <loop>\n  Pause future runs; the current run continues.",
  start: "pievo start <loop>\n  Enable a paused loop and re-arm its existing schedule; preserved queued work becomes eligible immediately.",
  stop: `pievo stop <loop>
  Pause the loop, cancel queued work, and request current-run termination.
  A running run remains running until the daemon confirms cancellation.`,
  delete: `pievo delete <loop> [--force]
  Stop first, then delete server history, memory, and artifacts.
  Local project files are never deleted. --force requires a prior Delete request,
  this machine's owner authority, and explicit local confirmation; it may retire server
  authority while a local process is still running.`,
  run: "pievo run stop <run>\n  Stop one pending or running run without pausing its loop. A running run changes state only after daemon confirmation.",
  log: "pievo log [<loop>] [--limit 1..20] [--status ok|block] [--phase done|error|canceled] [--run <index|UUID> [--diff]] [--json]\n  Show bounded run history or detail. <loop> defaults from the current workdir.",
  show: "pievo show [<loop>] [--full] [--json]\n  Show canonical config and recent runs. For an edit, select only changed fields from --json; id is read-only.",
  loops: "pievo loops [--fields a,b] [--json]\n  List loops on this machine.",
  edit: `pievo edit <loop> --json '<patch>' [--dry-run]
  Use --json - to read the patch from stdin. Inspect first with: pievo show <loop> --json

  Accepted fields: name, tags, schedule, workdir, agent, model, reasoningEffort,
  prompt, artifacts, enabled. Unknown fields are rejected.
  The patch changes only supplied fields; schedule requires a complete replacement
  value. Use null for the provider-default model or
  reasoning effort. Use --dry-run to preview normalized before/after values without
  changing the loop.`,
  file: `pievo file list <loop> | file get <loop> <name> | file set <loop> <name> --from <path|->
  Inspect or replace a loop's MEMORY.md and artifact files (use --from - for stdin).
  An owner edit made while a run is executing wins over that run's version.
  Limits: MEMORY.md 8000 characters, artifacts 256 KB; over-limit content is rejected.`,
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
