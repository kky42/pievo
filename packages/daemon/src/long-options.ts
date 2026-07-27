export type ParsedLongOptions = {
  positional: string[];
  flags: Record<string, string | boolean>;
  occurrences: Array<{ key: string; value: string | boolean }>;
};

/**
 * Parse GNU-style long options without deciding which option names a command accepts.
 * The caller controls whether a bare option consumes the following token; inline
 * `--key=value` values are always retained for command-specific validation.
 */
export function parseLongOptions(
  args: string[],
  takesNextValue: (key: string) => boolean,
): ParsedLongOptions {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  const occurrences: ParsedLongOptions["occurrences"] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }

    const body = arg.slice(2);
    const equals = body.indexOf("=");
    if (equals >= 0) {
      const key = body.slice(0, equals);
      const value = body.slice(equals + 1);
      flags[key] = value;
      occurrences.push({ key, value });
      continue;
    }

    const next = args[i + 1];
    const value = takesNextValue(body) && next !== undefined && !next.startsWith("--")
      ? next
      : true;
    flags[body] = value;
    occurrences.push({ key: body, value });
    if (value !== true) i++;
  }
  return { positional, flags, occurrences };
}
