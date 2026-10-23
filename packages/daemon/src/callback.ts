/** Inside a run the `pievo` shim answers every command with the run contract: a
 * run reports through its final response, and owner commands need the owner. */
export async function runCallback(_argv: string[]): Promise<number> {
  process.stderr.write(
    "pievo: commands are not available inside a Pievo run. Edit loop files in $PIEVO_LOOP_DIR, "
      + "then end your final response with a summary, an optional `ATTENTION: <reason>` line, "
      + "and a last line `STATUS: ok|block`.\n",
  );
  return 2;
}
