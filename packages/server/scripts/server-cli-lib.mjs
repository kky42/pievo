import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 3000;
const MALFORMED_LOCK_GRACE_MS = 5_000;

export function usage() {
  return `Usage: pievo-server <start|status|restart|stop> [options]

Commands:
  start                 start in the background (idempotent)
  start --foreground    run in the foreground
  status                show local process status
  restart               stop, then start the currently installed server
  stop                  gracefully stop the local server

Options:
  --host <host>          bind host (default: HOST/NITRO_HOST or 127.0.0.1)
  --port <port>          bind port (default: PORT/NITRO_PORT/PIEVO_PORT or 3000)
  --data-dir <path>      select the instance (database, blobs, pid, lock, and log)
  -h, --help             show this help

Restart preserves the recorded instance host/port unless a flag or bind environment
variable overrides it. The default bind is local-only. Set --host 0.0.0.0 only with
appropriate auth and network controls.`;
}

export function parseArgs(argv) {
  if (argv.includes("--help") || argv.includes("-h") || argv[0] === "help") return { command: "help" };
  const command = argv[0];
  if (!["start", "status", "restart", "stop", "_serve"].includes(command)) {
    throw new Error(command ? `unknown command: ${command}` : "a command is required");
  }
  const out = { command, foreground: false };
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--foreground" && (command === "start" || command === "restart")) {
      out.foreground = true;
      continue;
    }
    const match = arg.match(/^--(host|port|data-dir)(?:=(.*))?$/);
    if (match) {
      const key = match[1] === "data-dir" ? "dataDir" : match[1];
      const value = match[2] ?? argv[++i];
      if (!value || value.startsWith("--")) throw new Error(`${arg.split("=")[0]} requires a value`);
      out[key] = value;
      continue;
    }
    throw new Error(`unknown option for ${command}: ${arg}`);
  }
  if ((command === "status" || command === "stop") && (out.host || out.port || out.foreground)) {
    throw new Error(`${command} only accepts --data-dir`);
  }
  return out;
}

function validPort(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`invalid port: ${value}`);
  return n;
}

function firstSet(env, names) {
  for (const name of names) {
    if (env[name] !== undefined && String(env[name]).trim()) return env[name];
  }
  return undefined;
}

export function buildEnvPlan(options, baseEnv = process.env) {
  const dataDir = path.resolve(options.dataDir || baseEnv.PIEVO_DATA_DIR?.trim() || path.join(os.homedir(), ".pievo"));
  const host = String(options.host || firstSet(baseEnv, ["NITRO_HOST", "HOST"]) || DEFAULT_HOST).trim();
  if (!host) throw new Error("host cannot be empty");
  const port = validPort(options.port || firstSet(baseEnv, ["NITRO_PORT", "PORT", "PIEVO_PORT"]) || DEFAULT_PORT);
  const env = {
    ...baseEnv,
    NODE_ENV: "production",
    PIEVO_DATA_DIR: dataDir,
    NITRO_HOST: host,
    HOST: host,
    NITRO_PORT: String(port),
    PORT: String(port),
  };
  delete env.PIEVO_SERVER_LAUNCH_NONCE;
  if (!env.DATABASE_URL && !env.PIEVO_DB) env.PIEVO_DB = "pglite";
  return {
    env,
    dataDir,
    host,
    port,
    pidFile: path.join(dataDir, "server.pid"),
    lockFile: path.join(dataDir, "server.start.lock"),
    logFile: path.join(dataDir, "server.log"),
    readyUrl: `http://${hostForUrl(host)}:${port}/api/ready`,
  };
}

export function buildRestartPlan(options, baseEnv, record) {
  const preserved = { ...options };
  if (preserved.host === undefined && firstSet(baseEnv, ["NITRO_HOST", "HOST"]) === undefined && record?.host) {
    preserved.host = record.host;
  }
  if (preserved.port === undefined && firstSet(baseEnv, ["NITRO_PORT", "PORT", "PIEVO_PORT"]) === undefined && record?.port) {
    preserved.port = String(record.port);
  }
  return buildEnvPlan(preserved, baseEnv);
}

export function withLaunchNonce(plan, nonce = crypto.randomBytes(24).toString("base64url")) {
  return {
    ...plan,
    launchNonce: nonce,
    env: { ...plan.env, PIEVO_SERVER_LAUNCH_NONCE: nonce },
  };
}

function hostForUrl(host) {
  if (host === "0.0.0.0" || host === "::") return "127.0.0.1";
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

export function processStartTime(pid, exec = execFileSync) {
  // Linux (including node:slim containers): procfs needs no optional `ps` binary.
  // Boot id + kernel start ticks uniquely identify a pid across reuse and reboot.
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
    const startTicks = fields[19]; // field 22 overall; fields[] begins at field 3
    const bootId = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    if (startTicks && bootId) return `linux:${bootId}:${startTicks}`;
  } catch {}
  // macOS and other POSIX hosts: one identical ps representation at write/check.
  try {
    const value = exec("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return value ? `ps:${value}` : undefined;
  } catch {
    return undefined;
  }
}

function validPidRecord(value) {
  if (![1, 2].includes(value?.version)) return false;
  if (!Number.isInteger(value.pid) || value.pid <= 0 || typeof value.startTime !== "string" || !value.startTime) return false;
  if (typeof value.host !== "string" || !value.host || !Number.isInteger(value.port)) return false;
  if (value.version === 2) {
    if (!['starting', 'running'].includes(value.state)) return false;
    if (typeof value.launchNonce !== "string" || !value.launchNonce) return false;
    if (typeof value.managedGroup !== "boolean") return false;
  }
  return true;
}

function readPidResult(pidFile) {
  let text;
  try {
    text = fs.readFileSync(pidFile, "utf8");
  } catch (error) {
    return error?.code === "ENOENT"
      ? { kind: "absent" }
      : { kind: "malformed", error: `cannot read pid record: ${error?.message ?? error}` };
  }
  try {
    const value = JSON.parse(text);
    return validPidRecord(value)
      ? { kind: "valid", record: value }
      : { kind: "malformed", error: "malformed pid record" };
  } catch {
    return { kind: "malformed", error: "malformed pid record" };
  }
}

export function readPidRecord(pidFile) {
  const result = readPidResult(pidFile);
  return result.kind === "valid" ? result.record : undefined;
}

function sameIdentity(a, b) {
  if (!a || !b || a.pid !== b.pid || a.startTime !== b.startTime) return false;
  if (a.launchNonce !== undefined && b.launchNonce !== a.launchNonce) return false;
  return true;
}

function atomicWrite(file, value, mode = 0o600) {
  const temp = `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value)}\n`, { mode });
  fs.renameSync(temp, file);
}

export function writePidRecord(plan, options = {}) {
  const pid = options.pid ?? process.pid;
  const startTime = options.startTime ?? processStartTime(pid);
  if (!startTime) throw new Error("cannot determine process start time; refusing to create an unsafe pid file");
  if (!options.launchNonce) throw new Error("launch nonce is required for a managed pid record");
  fs.mkdirSync(plan.dataDir, { recursive: true });
  const record = {
    version: 2,
    pid,
    startTime,
    host: plan.host,
    port: plan.port,
    state: options.state ?? "starting",
    launchNonce: options.launchNonce,
    managedGroup: options.managedGroup ?? false,
    startedAt: new Date().toISOString(),
  };
  atomicWrite(plan.pidFile, record);
  return record;
}

export function updatePidRecordState(plan, expected, state) {
  const record = readPidRecord(plan.pidFile);
  if (!sameIdentity(expected, record)) throw new Error("pid authority changed during startup");
  const updated = { ...record, state };
  atomicWrite(plan.pidFile, updated);
  return updated;
}

export function clearPidRecord(pidFile, expected) {
  if (expected !== undefined) {
    const record = readPidRecord(pidFile);
    if (typeof expected === "number") {
      if (record?.pid !== expected) return false;
    } else if (!sameIdentity(expected, record)) {
      return false;
    }
  }
  try {
    fs.rmSync(pidFile);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function defaultProbe(pid) {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    if (error?.code === "ESRCH") return "gone";
    if (error?.code === "EPERM") return "alive";
    return "unknown";
  }
}

/** Whether the exact recorded process still owns this pid. */
export function recordedProcessState(record, deps = {}) {
  const probe = deps.probe ?? defaultProbe;
  const startTime = deps.startTime ?? processStartTime;
  const probed = probe(record.pid);
  if (probed === "gone" || probed === false) return { state: "gone" };
  if (probed === "unknown") return { state: "unsafe", error: "cannot determine whether the recorded process is alive" };
  const actual = startTime(record.pid);
  if (!actual) return { state: "unsafe", error: "cannot verify the live process start time" };
  return actual === record.startTime
    ? { state: "same" }
    : { state: "gone", reused: true };
}

export function pidStatus(pidFile, deps = {}) {
  let result;
  if (deps.read) {
    const record = deps.read(pidFile);
    result = record ? { kind: "valid", record } : { kind: "absent" };
  } else {
    result = readPidResult(pidFile);
  }
  if (result.kind === "absent") return { state: "stopped" };
  if (result.kind === "malformed") return { state: "unsafe", error: result.error };
  const identity = recordedProcessState(result.record, {
    probe: deps.probe ?? (deps.alive ? (pid) => deps.alive(pid) ? "alive" : "gone" : undefined),
    startTime: deps.startTime,
  });
  if (identity.state === "unsafe") return { state: "unsafe", record: result.record, error: identity.error };
  if (identity.state === "gone") {
    const clear = deps.clear ?? (() => clearPidRecord(pidFile, result.record));
    clear(result.record);
    return { state: "stopped", stale: true, record: result.record };
  }
  return { state: "running", record: result.record };
}

export async function readinessReady(url, expectedNonce, deps = {}) {
  const fetchImpl = deps.fetch ?? fetch;
  try {
    const response = await fetchImpl(url, { signal: deps.signal ?? AbortSignal.timeout(1_500) });
    if (!response.ok) return false;
    const body = await response.json();
    return body?.ok === true && body?.nonce === expectedNonce;
  } catch {
    return false;
  }
}

export async function waitFor(predicate, timeoutMs, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

async function defaultWaitForGone(record, timeoutMs, deps) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = recordedProcessState(record, deps);
    if (state.state === "gone") return state;
    if (state.state === "unsafe") return state;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return recordedProcessState(record, deps);
}

/** Signal one verified process (or its managed launch group) and prove it is gone. */
export async function terminateRecordedProcess(record, deps = {}) {
  const signal = deps.signal ?? ((target, name) => process.kill(target, name));
  const waitForGone = deps.waitForGone ?? ((timeout) => defaultWaitForGone(record, timeout, deps));
  const gracefulTimeoutMs = deps.gracefulTimeoutMs ?? 10_000;
  const forceTimeoutMs = deps.forceTimeoutMs ?? 2_000;
  const target = record.managedGroup ? -record.pid : record.pid;
  const send = (name) => {
    try {
      signal(target, name);
      return true;
    } catch (error) {
      // Exit can race the signal syscall. ESRCH is success only after a fresh
      // identity check positively proves that the recorded process is gone.
      if (error?.code === "ESRCH") {
        const state = recordedProcessState(record, deps);
        if (state.state === "gone") return false;
        if (state.state === "unsafe") throw new Error(state.error);
      }
      throw error;
    }
  };

  const before = recordedProcessState(record, deps);
  if (before.state === "gone") return { forced: false };
  if (before.state === "unsafe") throw new Error(before.error);
  if (!send("SIGTERM")) return { forced: false };
  let after = await waitForGone(gracefulTimeoutMs);
  if (after.state === "gone") return { forced: false };
  if (after.state === "unsafe") throw new Error(after.error);

  // Re-verify immediately before SIGKILL. Never signal a pid that may have been reused.
  const preKill = recordedProcessState(record, deps);
  if (preKill.state === "gone") return { forced: false };
  if (preKill.state === "unsafe") throw new Error(preKill.error);
  if (!send("SIGKILL")) return { forced: false };
  after = await waitForGone(forceTimeoutMs);
  if (after.state === "unsafe") throw new Error(after.error);
  if (after.state !== "gone") throw new Error(`process ${record.pid} did not exit after SIGKILL`);
  return { forced: true };
}

function lockOwnerState(lock, deps = {}) {
  if (!Number.isInteger(lock?.pid) || lock.pid <= 0 || typeof lock.startTime !== "string" || !lock.startTime) return undefined;
  return recordedProcessState(lock, deps);
}

/** Atomic per-data-dir launch lock. Stale locks recover; live/uncertain owners fail closed. */
export function acquireStartLock(plan, deps = {}) {
  fs.mkdirSync(plan.dataDir, { recursive: true });
  const now = deps.now ?? Date.now;
  const malformedGraceMs = deps.malformedGraceMs ?? MALFORMED_LOCK_GRACE_MS;
  for (let attempt = 0; attempt < 4; attempt++) {
    const startTime = (deps.startTime ?? processStartTime)(process.pid);
    if (!startTime) throw new Error("cannot determine launcher process start time");
    const token = crypto.randomBytes(18).toString("base64url");
    let fd;
    try {
      fd = fs.openSync(plan.lockFile, "wx", 0o600);
      fs.writeFileSync(fd, `${JSON.stringify({ version: 1, pid: process.pid, startTime, token, createdAt: new Date(now()).toISOString() })}\n`);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      return () => {
        try {
          const current = JSON.parse(fs.readFileSync(plan.lockFile, "utf8"));
          if (current?.token === token) fs.rmSync(plan.lockFile);
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
      };
    } catch (error) {
      if (fd !== undefined) try { fs.closeSync(fd); } catch {}
      if (error?.code !== "EEXIST") throw error;
    }

    let lock;
    try {
      lock = JSON.parse(fs.readFileSync(plan.lockFile, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      let age = 0;
      try { age = now() - fs.statSync(plan.lockFile).mtimeMs; } catch (statError) {
        if (statError?.code === "ENOENT") continue;
        throw statError;
      }
      if (age >= malformedGraceMs) {
        fs.rmSync(plan.lockFile, { force: true });
        continue;
      }
      const busy = new Error("another pievo-server lifecycle operation is in progress (lock is still being written)");
      busy.code = "START_LOCKED";
      throw busy;
    }

    const owner = lockOwnerState(lock, deps);
    if (!owner) {
      const age = now() - fs.statSync(plan.lockFile).mtimeMs;
      if (age >= malformedGraceMs) {
        fs.rmSync(plan.lockFile, { force: true });
        continue;
      }
    } else if (owner.state === "gone") {
      fs.rmSync(plan.lockFile, { force: true });
      continue;
    } else if (owner.state === "unsafe") {
      throw new Error(`${owner.error}; refusing to recover lifecycle lock for pid ${lock.pid}`);
    }
    const busy = new Error("another pievo-server lifecycle operation is in progress");
    busy.code = "START_LOCKED";
    throw busy;
  }
  throw new Error("could not safely acquire pievo-server lifecycle lock");
}

export async function acquireStartLockEventually(plan, timeoutMs, deps = {}) {
  let last;
  const ok = await waitFor(() => {
    try {
      last = acquireStartLock(plan, deps);
      return true;
    } catch (error) {
      if (error?.code !== "START_LOCKED") throw error;
      return false;
    }
  }, timeoutMs, deps.intervalMs ?? 100);
  if (!ok) throw new Error("timed out waiting for another pievo-server lifecycle operation");
  return last;
}
