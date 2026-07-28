export const REEXEC_WRAPPER_MARKER = "#!/bin/sh\nexec ";

function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function reexecWrapperContents(
  execPath = process.execPath,
  execArgv = process.execArgv,
  entry = process.argv[1] ?? "",
): string {
  const parts = [execPath, ...execArgv, entry].map(shQuote);
  return `${REEXEC_WRAPPER_MARKER}${parts.join(" ")} "$@"\n`;
}
