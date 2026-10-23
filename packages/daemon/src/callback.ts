import { postCli, printCliResponse } from "./cli-client.js";

const RUN_HELP = `Inside a Pievo run, pievo is read-only and sees only this loop:
  pievo log [--since ISO] [--until ISO] [--status ok|block] [--attention] [--limit 1..20] [--json]
  pievo log --run <index>     one run's full response and memory change
  pievo show [--full]         the loop's config, schedule, and run counts
  pievo memory                the loop's MEMORY.md as stored on the server
Edit $PIEVO_LOOP_DIR/MEMORY.md to change memory, and end your final response with
a summary, an optional \`ATTENTION: <reason>\` line, and a last line \`STATUS: ok|block\`.
`;

/** Inside a run the `pievo` shim forwards to the server with the run's read-only
 * context token; the server allows only show/log/memory for the run's own loop. */
export async function runCallback(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl?: typeof fetch,
): Promise<number> {
  if (!argv.length || ["--help", "-h", "help"].includes(argv[0]!)) {
    process.stdout.write(RUN_HELP);
    return 0;
  }
  const token = env.PIEVO_RUN_CONTEXT;
  const server = env.PIEVO_SERVER_URL;
  if (!token || !server) {
    process.stderr.write("pievo: this run has no server context; pievo commands are unavailable\n");
    return 2;
  }
  const result = await postCli(argv, { deviceToken: token, server, ...(fetchImpl ? { fetchImpl } : {}) });
  if (result.kind === "network-error") {
    process.stderr.write(`pievo: ${result.message}\n`);
    return 1;
  }
  if (result.kind === "not-configured") return 2;
  return printCliResponse(result.body, result.status, (s) => void process.stdout.write(s));
}
