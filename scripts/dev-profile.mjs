import path from "node:path";

const DEFAULT_REPO_ROOT = path.resolve(import.meta.dirname, "..");

function shellArg(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function developmentEnvironment(
  env = process.env,
  { repoRoot = DEFAULT_REPO_ROOT, execPath = process.execPath } = {},
) {
  const developmentRoot = path.join(repoRoot, ".pievo", "development");
  const port = env.PIEVO_PORT || "3001";
  return {
    PIEVO_DATA_DIR: env.PIEVO_DATA_DIR || path.join(developmentRoot, "server"),
    PIEVO_HOME: env.PIEVO_HOME || path.join(developmentRoot, "daemon"),
    PIEVO_PORT: port,
    PIEVO_BASE_URL: env.PIEVO_BASE_URL || `http://127.0.0.1:${port}`,
    PIEVO_CLI: env.PIEVO_CLI || `${shellArg(execPath)} ${shellArg(path.join(repoRoot, "packages", "daemon", "scripts", "dev.mjs"))}`,
  };
}

export function developmentProcessEnvironment(
  fileEnv = {},
  shellEnv = process.env,
  options = {},
) {
  const configured = { ...fileEnv, ...shellEnv };
  return { ...configured, ...developmentEnvironment(configured, options) };
}
