/**
 * Callback mode — `pievo <verb> [...flags]` invoked by claude (via the PATH
 * wrapper) inside a run. Delegates to the shared CLI client (`postCli`): it picks the
 * run token from the env and POSTs `{argv}` to
 * `/api/machine/cli`. This module renders the `{text, exitCode}` reply.
 */
import { postCli, printCliResponse } from "./cli-client.js";

export async function runCallback(argv: string[]): Promise<number> {
  const verb = argv[0];
  if (verb === "--help" || verb === "-h" || verb === "help" || (verb === "report" && argv.slice(1).some((arg) => arg === "--help" || arg === "-h"))) {
    process.stdout.write("pievo report --status keep|no-change|block --message <text>\n");
    return 0;
  }
  if (verb !== "report") {
    process.stderr.write("pievo: only `report` is available inside a run\n");
    return 2;
  }
  const r = await postCli(argv);
  if (r.kind === "not-configured") {
    process.stderr.write("pievo: run callback not configured\n");
    return 2;
  }
  if (r.kind === "network-error") {
    process.stderr.write(`pievo: ${r.message}\n`);
    return 1;
  }
  return printCliResponse(r.body, r.status, (s) => process.stdout.write(s));
}
