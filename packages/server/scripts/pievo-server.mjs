#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  acquireStartLock,
  acquireStartLockEventually,
  buildEnvPlan,
  buildRestartPlan,
  clearPidRecord,
  parseArgs,
  pidStatus,
  processStartTime,
  readinessReady,
  readPidRecord,
  recordedProcessState,
  terminateRecordedProcess,
  updatePidRecordState,
  usage,
  waitFor,
  withLaunchNonce,
  writePidRecord,
} from "./server-cli-lib.mjs";

const scriptFile = fileURLToPath(import.meta.url);
const packageRoot = path.resolve(path.dirname(scriptFile), "..");
const packageVersion = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")).version;
const READY_TIMEOUT_MS = 60_000;
const DETACHED_LAUNCH_TIMEOUT_MS = 120_000;
const STOP_TIMEOUT_MS = 10_000;
const FORCE_STOP_TIMEOUT_MS = 2_000;
const LOCK_HANDOFF_TIMEOUT_MS = 5_000;

function installShutdown(plan, expected) {
  let stopping = false;
  let stopSignal;
  let prestartChild;
  let nitroLoaded = false;
  let replayedForNitro = false;

  const shutdownApplication = () => {
    const booted = globalThis.__pievoBooted;
    if (!booted) return;
    void Promise.resolve(booted)
      .then((value) => value.shutdown())
      .catch((error) => console.error(`[pievo-server] application shutdown failed: ${error instanceof Error ? error.message : error}`));
  };

  const onSignal = (signal) => {
    if (!stopping) {
      stopping = true;
      stopSignal = signal;
      console.log(`[pievo-server] received ${signal}; shutting down`);
      shutdownApplication();
      if (prestartChild?.exitCode === null && prestartChild?.signalCode === null) {
        try { prestartChild.kill(signal); } catch {}
      }
    }
  };

  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  // This process is authoritative for its own clean exit. SIGKILL cannot run this
  // hook, so an external stopper still has to prove death before clearing.
  process.on("exit", () => clearPidRecord(plan.pidFile, expected));

  return {
    get stopping() { return stopping; },
    trackPrestart(child) { prestartChild = child; },
    clearPrestart(child) { if (prestartChild === child) prestartChild = undefined; },
    nitroLoaded() {
      nitroLoaded = true;
      // If the first signal arrived while Nitro was importing, its graceful HTTP
      // handler did not see it. Replay once after srvx has installed that handler.
      if (stopping && !replayedForNitro) {
        replayedForNitro = true;
        setImmediate(() => {
          try { process.kill(process.pid, stopSignal ?? "SIGTERM"); } catch {}
        });
      }
    },
    requestShutdown(signal = "SIGTERM") {
      onSignal(signal);
      if (nitroLoaded && !replayedForNitro) {
        replayedForNitro = true;
        setImmediate(() => {
          try { process.kill(process.pid, signal); } catch {}
        });
      }
    },
  };
}

async function runPrestart(plan, shutdown) {
  const child = spawn(process.execPath, [path.join(packageRoot, "scripts", "prestart.mjs")], {
    cwd: packageRoot,
    env: plan.env,
    stdio: "inherit",
  });
  shutdown.trackPrestart(child);
  try {
    const result = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    if (shutdown.stopping) throw new Error("startup interrupted by shutdown signal");
    if (result.code !== 0) {
      throw new Error(`migration prestart failed (${result.signal ? `signal ${result.signal}` : `exit ${result.code ?? "unknown"}`})`);
    }
  } finally {
    shutdown.clearPrestart(child);
  }
}

async function waitForPidAuthority(plan, expected, shutdown) {
  return waitFor(() => {
    if (shutdown.stopping) return true;
    const current = readPidRecord(plan.pidFile);
    return current?.pid === expected.pid
      && current.startTime === expected.startTime
      && current.launchNonce === expected.launchNonce;
  }, 5_000);
}

async function serve(plan, expected) {
  // Signal handling comes first: startup remains controllable while waiting for
  // the parent record and while the async migration child is running.
  const shutdown = installShutdown(plan, expected);
  if (!(await waitForPidAuthority(plan, expected, shutdown))) {
    throw new Error("launcher did not establish pid authority before startup");
  }
  if (shutdown.stopping) return;

  const current = pidStatus(plan.pidFile);
  if (current.state !== "running" || current.record.pid !== process.pid || current.record.startTime !== expected.startTime) {
    throw new Error("pid authority changed before startup");
  }

  await runPrestart(plan, shutdown);
  if (shutdown.stopping) return;
  const afterPrestart = readPidRecord(plan.pidFile);
  if (afterPrestart?.pid !== expected.pid
    || afterPrestart.startTime !== expected.startTime
    || afterPrestart.launchNonce !== expected.launchNonce) {
    throw new Error("pid authority changed during migration prestart");
  }

  try {
    await import(pathToFileURL(path.join(packageRoot, ".output", "server", "index.mjs")).href);
    shutdown.nitroLoaded();
    if (shutdown.stopping) return;

    const ready = await waitFor(
      () => shutdown.stopping || readinessReady(plan.readyUrl, expected.launchNonce),
      READY_TIMEOUT_MS,
    );
    if (shutdown.stopping) return;
    if (!ready) throw new Error(`server did not become ready at ${plan.readyUrl}`);
    updatePidRecordState(plan, expected, "running");
    console.log(`[pievo-server] ready at http://${plan.host}:${plan.port} (pid ${process.pid})`);
  } catch (error) {
    // Once Nitro may own a listening socket, ask its srvx signal handler to drain
    // HTTP rather than forcing process.exit from our application handler.
    shutdown.requestShutdown("SIGTERM");
    throw error;
  }
}

async function waitForProcessStart(pid, timeoutMs = 2_000) {
  let value;
  await waitFor(() => {
    value = processStartTime(pid);
    return Boolean(value);
  }, timeoutMs, 25);
  return value;
}

async function waitForDetachedReady(plan, expected) {
  const deadline = Date.now() + DETACHED_LAUNCH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const identity = recordedProcessState(expected);
    if (identity.state === "gone") throw new Error(`server process ${expected.pid} exited during startup`);
    if (identity.state === "unsafe") throw new Error(identity.error);
    const current = readPidRecord(plan.pidFile);
    if (current?.state === "running"
      && current.pid === expected.pid
      && current.startTime === expected.startTime
      && current.launchNonce === expected.launchNonce
      && await readinessReady(plan.readyUrl, expected.launchNonce)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`server failed to become ready; see ${plan.logFile}`);
}

async function cleanFailedLaunch(plan, expected) {
  const state = recordedProcessState(expected);
  if (state.state === "gone") {
    clearPidRecord(plan.pidFile, expected);
    return;
  }
  if (state.state === "unsafe") throw new Error(`${state.error}; retaining ${plan.pidFile}`);
  await terminateRecordedProcess(expected, {
    gracefulTimeoutMs: STOP_TIMEOUT_MS,
    forceTimeoutMs: FORCE_STOP_TIMEOUT_MS,
  });
  clearPidRecord(plan.pidFile, expected);
}

async function start(basePlan, foreground) {
  const existing = pidStatus(basePlan.pidFile);
  if (existing.state === "running") {
    console.log(`pievo-server is already ${existing.record.state === "starting" ? "starting" : "running"} (pid ${existing.record.pid}, http://${existing.record.host}:${existing.record.port})`);
    return;
  }
  if (existing.state === "unsafe") throw new Error(`${existing.error}; refusing to start over the existing pid record`);

  const release = acquireStartLock(basePlan);
  try {
    const raced = pidStatus(basePlan.pidFile);
    if (raced.state === "running") {
      console.log(`pievo-server is already ${raced.record.state === "starting" ? "starting" : "running"} (pid ${raced.record.pid})`);
      return;
    }
    if (raced.state === "unsafe") throw new Error(`${raced.error}; refusing to start over the existing pid record`);

    const plan = withLaunchNonce(basePlan);
    if (foreground) {
      const record = writePidRecord(plan, {
        launchNonce: plan.launchNonce,
        managedGroup: false,
        state: "starting",
      });
      await serve(plan, record);
      return;
    }

    fs.mkdirSync(plan.dataDir, { recursive: true });
    const logFd = fs.openSync(plan.logFile, "a", 0o600);
    let child;
    try {
      child = spawn(process.execPath, [scriptFile, "_serve"], {
        cwd: packageRoot,
        env: plan.env,
        detached: true,
        stdio: ["ignore", logFd, logFd],
      });
    } finally {
      fs.closeSync(logFd);
    }
    if (!child.pid) throw new Error("failed to spawn server process");
    child.unref();

    const childStart = await waitForProcessStart(child.pid);
    if (!childStart) throw new Error(`cannot verify spawned server process ${child.pid}`);
    const record = writePidRecord(plan, {
      pid: child.pid,
      startTime: childStart,
      launchNonce: plan.launchNonce,
      managedGroup: true,
      state: "starting",
    });

    try {
      await waitForDetachedReady(plan, record);
    } catch (error) {
      try {
        await cleanFailedLaunch(plan, record);
      } catch (cleanupError) {
        throw new Error(`${error instanceof Error ? error.message : error}; cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : cleanupError}`);
      }
      throw error;
    }
    console.log(`pievo-server started (pid ${child.pid}, http://${plan.host}:${plan.port})`);
    console.log(`log: ${plan.logFile}`);
  } finally {
    release();
  }
}

async function stop(plan) {
  let release;
  let stoppedRecord;
  try {
    try {
      release = acquireStartLock(plan);
    } catch (error) {
      if (error?.code !== "START_LOCKED") throw error;
      // A detached launcher owns the lock until readiness/failure. Its child pid
      // record is written before migrations, so stop can still terminate exactly
      // that starting process, then wait for the launcher to relinquish the lock.
      const launching = pidStatus(plan.pidFile);
      if (launching.state !== "running") {
        if (launching.state === "unsafe") throw new Error(`${launching.error}; refusing to stop during launch`);
        throw new Error("a launch is in progress but no server process can be safely identified");
      }
      stoppedRecord = launching.record;
      const result = await terminateRecordedProcess(stoppedRecord, {
        gracefulTimeoutMs: STOP_TIMEOUT_MS,
        forceTimeoutMs: FORCE_STOP_TIMEOUT_MS,
      });
      if (result.forced) console.warn(`[pievo-server] graceful stop timed out; killed pid ${stoppedRecord.pid}`);
      clearPidRecord(plan.pidFile, stoppedRecord);
      release = await acquireStartLockEventually(plan, LOCK_HANDOFF_TIMEOUT_MS);
    }

    const status = pidStatus(plan.pidFile);
    if (status.state === "unsafe") throw new Error(`${status.error}; refusing to signal the existing pid record`);
    if (status.state === "running") {
      stoppedRecord = status.record;
      const result = await terminateRecordedProcess(stoppedRecord, {
        gracefulTimeoutMs: STOP_TIMEOUT_MS,
        forceTimeoutMs: FORCE_STOP_TIMEOUT_MS,
      });
      if (result.forced) console.warn(`[pievo-server] graceful stop timed out; killed pid ${stoppedRecord.pid}`);
      clearPidRecord(plan.pidFile, stoppedRecord);
    }

    if (stoppedRecord) console.log(`pievo-server stopped (pid ${stoppedRecord.pid})`);
    else console.log("pievo-server is not running");
  } finally {
    release?.();
  }
}

function status(plan) {
  const current = pidStatus(plan.pidFile);
  if (current.state === "running") {
    console.log(`pievo-server is ${current.record.state === "starting" ? "starting" : "running"} (pid ${current.record.pid})`);
    console.log(`url: http://${current.record.host}:${current.record.port}`);
    console.log(`data: ${plan.dataDir}`);
    return 0;
  }
  if (current.state === "unsafe") {
    const pid = current.record?.pid ? ` (pid ${current.record.pid})` : "";
    console.error(`pievo-server status is unsafe: ${current.error}${pid}`);
    return 1;
  }
  console.log(`pievo-server is stopped${current.stale ? " (cleared stale pid file)" : ""}`);
  return 1;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`pievo-server: ${error.message}\n\n${usage()}`);
    process.exitCode = 2;
    return;
  }
  if (options.command === "help") {
    console.log(usage());
    return;
  }
  if (options.command === "version") {
    console.log(`pievo-server v${packageVersion}`);
    return;
  }

  const inheritedNonce = process.env.PIEVO_SERVER_LAUNCH_NONCE;
  const instancePlan = buildEnvPlan(options);
  if (options.command === "_serve") {
    if (!inheritedNonce) throw new Error("internal serve command requires a launch nonce");
    const plan = { ...instancePlan, launchNonce: inheritedNonce, env: { ...instancePlan.env, PIEVO_SERVER_LAUNCH_NONCE: inheritedNonce } };
    const startTime = processStartTime(process.pid);
    if (!startTime) throw new Error("cannot verify server process identity");
    const expected = {
      pid: process.pid,
      startTime,
      launchNonce: inheritedNonce,
      managedGroup: true,
    };
    return serve(plan, expected);
  }
  if (options.command === "start") return start(instancePlan, options.foreground);
  if (options.command === "stop") return stop(instancePlan);
  if (options.command === "status") {
    process.exitCode = status(instancePlan);
    return;
  }
  if (options.command === "restart") {
    const before = pidStatus(instancePlan.pidFile);
    if (before.state === "unsafe") throw new Error(`${before.error}; refusing to restart the existing pid record`);
    const restartPlan = buildRestartPlan(options, process.env, before.record);
    await stop(instancePlan);
    await start(restartPlan, options.foreground);
  }
}

main().catch((error) => {
  console.error(`pievo-server: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
});
