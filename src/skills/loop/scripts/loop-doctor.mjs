#!/usr/bin/env node
import fs from "node:fs";

import {
  defaultPolicy,
  ensureLoopInfrastructure,
  failCli,
  loopPaths,
  parseArgs,
  printJson,
  readJsonFile,
  validateJsonLines,
  writeJsonFile
} from "./_loop-lib.mjs";

function usage() {
  return "Usage: node scripts/loop-doctor.mjs <loop-id> [--fix true|false]\n";
}

function collectIssues(paths) {
  const issues = [];
  if (!fs.existsSync(paths.dir)) {
    issues.push({ severity: "error", type: "missing_loop_dir", path: paths.dir });
    return issues;
  }

  for (const key of ["policy", "tasks", "runs", "metrics", "incidents"]) {
    if (!fs.existsSync(paths[key])) issues.push({ severity: "error", type: "missing_file", file: paths[key], key });
  }
  if (!fs.existsSync(paths.artifacts)) {
    issues.push({ severity: "warn", type: "missing_artifacts_dir", path: paths.artifacts });
  }
  if (!fs.existsSync(paths.state)) {
    issues.push({ severity: "warn", type: "missing_state_md", file: paths.state });
  }

  if (fs.existsSync(paths.policy)) {
    try {
      const policy = readJsonFile(paths.policy);
      if (policy.loop_id && policy.loop_id !== paths.id) {
        issues.push({ severity: "warn", type: "policy_loop_id_mismatch", expected: paths.id, actual: policy.loop_id });
      }
    } catch (error) {
      issues.push({ severity: "error", type: "invalid_policy_json", file: paths.policy, error: error.message });
    }
  }

  for (const key of ["tasks", "runs", "metrics", "incidents"]) {
    if (fs.existsSync(paths[key])) issues.push(...validateJsonLines(paths[key]));
  }
  return issues;
}

function applyFixes(paths, issues) {
  const fixes = [];
  if (issues.some((issue) => issue.type === "missing_loop_dir")) {
    ensureLoopInfrastructure(paths.id);
    fixes.push({ type: "created_loop_infrastructure", path: paths.dir });
  }
  fs.mkdirSync(paths.dir, { recursive: true });
  for (const issue of issues) {
    if (issue.type === "missing_file") {
      if (issue.key === "policy") writeJsonFile(paths.policy, defaultPolicy(paths.id));
      else fs.writeFileSync(issue.file, "", "utf8");
      fixes.push({ type: "created_file", file: issue.file });
    }
    if (issue.type === "missing_artifacts_dir") {
      fs.mkdirSync(paths.artifacts, { recursive: true });
      fixes.push({ type: "created_artifacts_dir", path: paths.artifacts });
    }
    if (issue.type === "policy_loop_id_mismatch") {
      writeJsonFile(paths.policy, defaultPolicy(paths.id));
      fixes.push({ type: "rewrote_policy", file: paths.policy });
    }
  }
  return fixes;
}

try {
  const { positionals, options } = parseArgs(process.argv.slice(2));
  const [loopId] = positionals;
  if (!loopId) throw new Error("loop-id is required");
  const paths = loopPaths(loopId);
  const fix = options.fix === "true";

  const before = collectIssues(paths);
  const fixes = fix ? applyFixes(paths, before) : [];
  const issues = fix ? collectIssues(paths) : before;
  const fatalCount = issues.filter((issue) => issue.severity === "error").length;
  printJson({ loop_id: paths.id, ok: fatalCount === 0, issues, fixes });
  process.exit(fatalCount === 0 ? 0 : 1);
} catch (error) {
  failCli(error, usage());
}
