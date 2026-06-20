#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { toErrorMessage } from "../src/utils.js";
import { DEFAULT_TIMEOUT_MS, defaultScenarioPaths, loadScenario } from "./scenario-loader.js";
import { runScenario } from "./scenario-runner.js";

function usage() {
  return `Usage:
  node e2e/run-scenario.js [scenario.yaml ...]

Options:
  --scenario <path>      Add a scenario file. Defaults to e2e/scenarios/*.yaml
  --model <model>        Pi model override (or PIEVO_E2E_MODEL)
  --reasoning <level>    Thinking level override (or PIEVO_E2E_REASONING)
  --timeout-ms <ms>      Per-step timeout (or PIEVO_E2E_TIMEOUT_MS)
  --out-dir <path>       Directory for run artifacts
  --verbose              Print per-step events
  --help                 Show help
`;
}

function looksLikeMissingValue(value) {
  return value === undefined || String(value).trim() === "" || /^-[A-Za-z-]/.test(String(value));
}

function requireValue(argv, index, optionName) {
  const value = argv[index + 1];
  if (looksLikeMissingValue(value)) {
    throw new Error(`${optionName} requires a value`);
  }
  return value;
}

export function parseArgs(argv) {
  const result = {
    scenarios: [],
    model: process.env.PIEVO_E2E_MODEL || "",
    reasoningEffort: process.env.PIEVO_E2E_REASONING || "",
    timeoutMs: Number(process.env.PIEVO_E2E_TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
    outDir: process.env.PIEVO_E2E_OUT_DIR || "",
    verbose: /^(1|true|yes|on)$/i.test(process.env.PIEVO_E2E_VERBOSE || "")
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      result.help = true;
      continue;
    }
    if (arg === "--scenario") {
      result.scenarios.push(requireValue(argv, index, arg));
      index += 1;
      continue;
    }
    if (arg === "--model") {
      result.model = requireValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--reasoning") {
      result.reasoningEffort = requireValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--timeout-ms") {
      result.timeoutMs = Number(requireValue(argv, index, arg));
      index += 1;
      continue;
    }
    if (arg === "--out-dir") {
      result.outDir = requireValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--verbose") {
      result.verbose = true;
      continue;
    }
    if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    }
    result.scenarios.push(arg);
  }

  if (!Number.isFinite(result.timeoutMs) || result.timeoutMs <= 0) {
    throw new Error("--timeout-ms must be a positive number");
  }

  return result;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(usage());
    return;
  }

  const scenarioPaths = options.scenarios.length > 0 ? options.scenarios : await defaultScenarioPaths();
  if (scenarioPaths.length === 0) {
    throw new Error("No scenario files found. Pass a scenario path or create e2e/scenarios/*.yaml.");
  }

  const reports = [];
  const failures = [];
  for (const scenarioPath of scenarioPaths) {
    try {
      const scenario = await loadScenario(scenarioPath);
      const report = await runScenario(scenario, options);
      reports.push(report);
      process.stderr.write(`✓ scenario ${scenario.name} complete: ${path.join(report.runDir, "report.json")}\n`);
    } catch (error) {
      failures.push({ scenarioPath, error: toErrorMessage(error) });
      process.stderr.write(`✗ scenario ${scenarioPath} failed: ${toErrorMessage(error)}\n`);
    }
  }

  if (failures.length > 0) {
    process.stderr.write(`${failures.length} scenario(s) failed.\n`);
    process.exitCode = 1;
    return;
  }

  process.stderr.write(`${reports.length} scenario(s) passed.\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}
