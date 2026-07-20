/**
 * `pievo --help` / `-h` / `help` — the usage screen, and `pievo -v` /
 * `--version` — the bare version line. Kept in its own module so both paths load
 * nothing heavy (no daemon/network), and so the verb list has a single readable
 * source. The usage screen leads with the daemon version (a troubleshooting
 * affordance, reusing `daemonVersion()`); when the version is unreadable it
 * degrades to the plain header instead of throwing. Grouped setup-vs-management;
 * the in-run callbacks (`pievo report …`, which the agent invokes via the PATH
 * wrapper) are NOT user commands and are deliberately omitted.
 *
 * The owner loop verbs (including lifecycle control) and the in-run callbacks are no longer
 * two separate mechanisms: both funnel through the one shared CLI client that POSTs to
 * the unified `/api/machine/cli` dispatch (see `cli-client.ts`) — only the LOCAL verbs
 * grouped below (up/down/update/skill/status) run without touching the server.
 */
import { daemonVersion } from "./version.js";

const HELP_BODY = ` connects this machine to a Pievo
server and runs your scheduled agent loops locally with your own coding agent.

Usage: pievo [command] [options]

  pievo                 Show the content-first HOME: this machine's live loops +
                          recent runs (the poll loop moved to \`up --foreground\`).

Setup
  up [--foreground]       Connect this machine / ensure its daemon is running
                          (idempotent; refreshes the pievo skill and the \`pievo\`
                          PATH shim). --foreground runs the poll loop attached in
                          this terminal instead of detached.
  new --json '<config>'   Create a loop from an inline JSON config (--json - reads
    [--dry-run]           stdin). --dry-run validates + previews, creates nothing.
  skill [status|install]  Manage the pievo agent skill install (user scope by
    [--project]           default; --project installs into the current directory).
  update [--force]        Update this machine's daemon to the version you invoked.
                          --force may abandon a terminal result that cannot be
                          persisted; use only as an explicit recovery action.

Management
  pause <loop>            Pause future runs. The current run will continue.
  start <loop>            Start a paused loop using its existing cadence.
  stop <loop>             Pause, cancel queued work, and request termination of the
                          current run. Requires daemon protocol 2 when one is running.
  delete <loop> [--force] Stop first, then delete Pievo history and synced artifact
                          metadata. Local project files are not deleted. --force
                          requires a prior Delete request and typed confirmation,
                          then removes authority even if a local process may run.
  run stop <run>          Stop one run without pausing its loop.
  status                  Show actionable daemon, protocol, connectivity, current-run,
                          cancellation, blocked-run, and report diagnostics.
  doctor                  Run the same actionable diagnostics as status.
  down [--force]          Stop the detached daemon. Default waits for report durability;
                          --force may abandon an unpersisted terminal result.
  show [<id>]             Show a loop's full editable config + recent state (the
                          device credential inspects any loop on this machine).
  log [<loop>]            Show a loop's recent runs (concise: status + metrics +
                          session id). Defaults to the loop for the current
                          directory (--json, --limit N).

Interactive (edit loops from your own agent session, using the stored device token)
  loops [--fields a,b]    List your loops (--json emits the raw JSON array).
    [--json]              Default columns are id/name/cron/enabled/nextFire;
                          --fields adds any of timezone,notify,model,goal,
                          taskFile,runs,lastOutcome.
  edit <id> --json '<obj>'  Edit a loop (JSON-only + --workflow-file/--ui-file/
    [--dry-run]           --schema-file; --dry-run previews before/after).

  -h, --help              Show this help.
  -v, --version           Print the daemon version and exit.
`;

/**
 * Concise per-verb usage, printed by `pievo <verb> --help` / `-h`. Kept terse on
 * purpose (the full screen above is one `--help` away): the load-bearing property is that
 * `<verb> --help` short-circuits to THIS text with NO side effect — critical for the
 * foot-gun verbs (`update` hands the daemon over immediately, `down` stops it). Every
 * command verb the router knows (`route.ts` COMMAND_VERBS) has an entry; a missing entry
 * degrades to the full usage screen rather than throwing.
 */
const VERB_USAGE: Record<string, string> = {
  up: "pievo up [--foreground]\n  Connect this machine / ensure its daemon is running (idempotent; refreshes the\n  pievo skill and PATH shim). --foreground runs the poll loop attached in this\n  terminal instead of detached.",
  new: "pievo new --json '<config>' [--dry-run]\n  Create a loop from an inline JSON config (--json - reads stdin). --dry-run\n  validates + previews, creating nothing.",
  skill: "pievo skill [status|install] [--project]\n  Manage the pievo agent skill install (user scope by default; --project installs\n  into the current directory).",
  update: "pievo update [--force]\n  Hand this machine's daemon over to the newer CLI. Default waits for terminal-report\n  durability; --force may abandon an unpersisted result and uncertain side effects.",
  pause: "pievo pause <loop>\n  Pause future runs. The current run will continue.",
  start: "pievo start <loop>\n  Start a paused loop and re-arm its existing cadence.",
  stop: "pievo stop <loop>\n  Pause this loop, cancel queued work, and stop the current run if it is still running?\n  A running process requires daemon protocol 2; otherwise update is required.",
  delete: "pievo delete <loop> [--force]\n  Stop this loop and delete its Pievo history and synced artifacts? Local project files\n  are not deleted. --force requires a prior Delete request and typed confirmation; it\n  removes server authority while a local process may still run.",
  run: "pievo run stop <run>\n  Stop one pending or running run without pausing its loop. Canceled is reported only\n  after daemon confirmation for a running process.",
  status: "pievo status\n  Show actionable daemon protocol, server connectivity, current run/stage, cancel\n  pending, terminal report, blocked prior run, and last report error diagnostics.",
  doctor: "pievo doctor\n  Run the same actionable local/server diagnostics as `pievo status`.",
  down: "pievo down [--force]\n  Stop the detached daemon. Default waits for terminal-report durability; --force\n  waits briefly for process cleanup, then may abandon an unpersisted result.",
  log: "pievo log [<loop>] [--json] [--limit N]\n  Show a loop's recent runs (concise: status + metrics + session id). Defaults to the\n  loop for the current directory.",
  show: "pievo show [<id>] [--full] [--json]\n  Show a loop's full editable config + recent state (the device credential inspects\n  any loop on this machine).",
  loops: "pievo loops [--fields a,b] [--json]\n  List your loops (--json emits the raw JSON array). Default columns are\n  id/name/cron/enabled/nextFire.",
  edit: "pievo edit <id> --json '<obj>' [--dry-run] [--workflow-file|--ui-file|--schema-file <path>]\n  Edit a loop (JSON-only + content-file trio). --dry-run previews before/after.",
  report: "pievo report ...\n  In-run only: the running agent reports progress/results. Outside a run this is rejected.",
  finish: "pievo finish ...\n  In-run only: the running agent marks a closed loop's goal met. Outside a run this is rejected.",
  complete: "pievo complete ...\n  In-run only alias of `finish`. Outside a run this is rejected.",
};

/** `pievo <version>` for humans, or a plain fallback when it's unreadable. */
function versionLabel(version: string | undefined): string {
  return version ? `pievo v${version}` : "pievo";
}

/**
 * `pievo <verb> --help` / `-h`: print that verb's concise usage and exit 0, running NO
 * handler side effect. Unknown verbs fall back to the full usage screen.
 */
export function printVerbHelp(
  verb: string,
  out: (s: string) => void = (s) => process.stdout.write(s),
  version: string | undefined = daemonVersion(),
): number {
  const usage = VERB_USAGE[verb];
  if (!usage) return printHelp(out, version);
  out(`${versionLabel(version)}\n\n${usage}\n\nRun \`pievo --help\` for all commands.\n`);
  return 0;
}

export function printHelp(
  out: (s: string) => void = (s) => process.stdout.write(s),
  version: string | undefined = daemonVersion(),
): number {
  out(`${versionLabel(version)} - the Pievo daemon:${HELP_BODY}`);
  return 0;
}

/** `pievo -v` / `--version`: just the version line, never starts the daemon. */
export function printVersion(
  out: (s: string) => void = (s) => process.stdout.write(s),
  version: string | undefined = daemonVersion(),
): number {
  out(`${version ? `pievo v${version}` : "pievo (version unknown)"}\n`);
  return 0;
}
