#!/usr/bin/env node
import {
  appendJsonLine,
  failCli,
  makeId,
  parseArgs,
  parseBoolean,
  parseNumber,
  printJson,
  readMetrics,
  requireLoop,
  resolveNow,
  summarizeMetrics
} from "./_loop-lib.mjs";

function usage() {
  return `Usage:
  node scripts/loop-metric.mjs add <loop-id> --kind true|proxy --name <metric> --value <number> [--higher-is-better true|false] [--artifact-id id] [--run-id id] [--context text] [--at ISO]
  node scripts/loop-metric.mjs summary <loop-id>
  node scripts/loop-metric.mjs list <loop-id> [--kind true|proxy]
`;
}

try {
  const { positionals, options } = parseArgs(process.argv.slice(2));
  const [command, loopId] = positionals;
  if (!command || !loopId) throw new Error("command and loop-id are required");
  const paths = requireLoop(loopId);
  const at = resolveNow(options);

  if (command === "add") {
    if (!options.kind || !["true", "proxy"].includes(options.kind)) throw new Error("--kind must be true or proxy");
    if (!options.name) throw new Error("--name is required");
    const value = parseNumber(options.value);
    if (value === undefined) throw new Error("--value is required");
    const record = {
      schema_version: 1,
      event: "metric",
      metric_id: options.metricId || makeId("metric", at),
      loop_id: paths.id,
      kind: options.kind,
      name: options.name,
      value,
      higher_is_better: parseBoolean(options.higherIsBetter, true),
      artifact_id: options.artifactId,
      run_id: options.runId,
      context: options.context,
      at
    };
    appendJsonLine(paths.metrics, record);
    printJson(record);
  } else if (command === "summary") {
    const metrics = readMetrics(paths.id);
    printJson({ loop_id: paths.id, metrics: summarizeMetrics(metrics) });
  } else if (command === "list") {
    const metrics = readMetrics(paths.id).filter((metric) => !options.kind || metric.kind === options.kind);
    printJson({ loop_id: paths.id, metrics });
  } else {
    throw new Error(`unknown command: ${command}`);
  }
} catch (error) {
  failCli(error, usage());
}
