import { spawn } from "node:child_process";
import path from "node:path";

import { developmentProcessEnvironment } from "../../../scripts/dev-profile.mjs";

const packageRoot = path.resolve(import.meta.dirname, "..");
const tsxCli = path.join(packageRoot, "node_modules", "tsx", "dist", "cli.mjs");
const entry = path.join(packageRoot, "src", "cli.ts");
const env = developmentProcessEnvironment({}, process.env);
const args = process.argv.slice(2);
if (args[0] === "--") args.shift();

const child = spawn(process.execPath, [tsxCli, entry, ...args], {
  env,
  stdio: "inherit",
});

child.once("error", (cause) => {
  console.error(`pievo dev: ${cause instanceof Error ? cause.message : String(cause)}`);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
