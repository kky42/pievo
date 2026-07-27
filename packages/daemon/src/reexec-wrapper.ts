/** Prefix shared by Pievo's callback and durable launcher wrappers. */
export const REEXEC_WRAPPER_MARKER = "#!/bin/sh\nexec ";

function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** A /bin/sh wrapper that replays the exact Node launcher before forwarding argv. */
export function reexecWrapperContents(
  execPath = process.execPath,
  execArgv = process.execArgv,
  entry = process.argv[1] ?? "",
): string {
  const parts = [execPath, ...execArgv, entry].map(shQuote);
  return `${REEXEC_WRAPPER_MARKER}${parts.join(" ")} "$@"\n`;
}
