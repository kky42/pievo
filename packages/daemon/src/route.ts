/** Pure CLI routing over argv/env. Lifecycle commands live only under `daemon`. */
const INTERACTIVE_VERBS = new Set(["loops", "edit", "pause", "start", "stop", "delete", "run"]);
const HELP_FLAGS = new Set(["--help", "-h", "help"]);
const HELP_FLAG_ARGS = new Set(["--help", "-h"]);
const VERSION_FLAGS = new Set(["--version", "-v"]);
const COMMAND_VERBS = new Set(["daemon", "new", "skill", "log", "show", ...INTERACTIVE_VERBS]);
const HELP_VERBS = new Set([...COMMAND_VERBS, "report"]);
const DAEMON_SUBCOMMANDS = new Set(["connect", "connections", "start", "stop", "restart", "status"]);

function hasHelpFlag(args: string[]): boolean {
  return args.some((a) => HELP_FLAG_ARGS.has(a));
}

export type Route =
  | { kind: "callback"; argv: string[] }
  | { kind: "help"; verb?: string }
  | { kind: "version" }
  | { kind: "daemonCommand"; command?: string; args: string[] }
  | { kind: "create"; args: string[] }
  | { kind: "skill"; args: string[] }
  | { kind: "log"; args: string[] }
  | { kind: "show"; args: string[] }
  | { kind: "interactive"; argv: string[] }
  | { kind: "runOnlyReport" }
  | { kind: "home" }
  | { kind: "unknown"; verb: string };

export function classify(argv: string[], env: NodeJS.ProcessEnv): Route {
  if (env.PIEVO_RUN_TOKEN) return { kind: "callback", argv };
  const verb = argv[0];
  if (verb !== undefined && HELP_FLAGS.has(verb)) return { kind: "help" };
  if (verb !== undefined && VERSION_FLAGS.has(verb)) return { kind: "version" };

  if (verb === "daemon") {
    const command = argv[1];
    if (command !== undefined && HELP_FLAG_ARGS.has(command)) return { kind: "help", verb: "daemon" };
    if (command !== undefined && DAEMON_SUBCOMMANDS.has(command) && hasHelpFlag(argv.slice(2))) {
      return { kind: "help", verb: `daemon ${command}` };
    }
    return { kind: "daemonCommand", command, args: argv.slice(2) };
  }

  if (verb !== undefined && HELP_VERBS.has(verb) && hasHelpFlag(argv.slice(1))) return { kind: "help", verb };
  if (verb === "new") return { kind: "create", args: argv.slice(1) };
  if (verb === "skill") return { kind: "skill", args: argv.slice(1) };
  if (verb === "log") return { kind: "log", args: argv.slice(1) };
  if (verb === "show") return { kind: "show", args: argv.slice(1) };
  if (verb !== undefined && INTERACTIVE_VERBS.has(verb)) return { kind: "interactive", argv };
  if (verb === "report") return { kind: "runOnlyReport" };
  if (argv.length === 0) return { kind: "home" };
  return { kind: "unknown", verb: verb! };
}
