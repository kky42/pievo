/** One-time, idempotent in-process backend boot (migrations, scheduler, sweep
 * interval). Guarded on `globalThis` to survive dev HMR. */
import { runMigrations, closeClient } from "../db/index.js";
import { repairTerminalRunLeases } from "../db/store.js";
import { logger } from "../logger.js";
import { MachineGateway, ONLINE_TTL_MS } from "../gateway/index.js";
import { CliGateway } from "../gateway/cli.js";
import { Scheduler, type Dispatcher } from "../scheduler/index.js";

interface Booted {
  scheduler: Scheduler;
  gateway: MachineGateway;
  cliGateway: CliGateway;
  abort: AbortController;
  shutdown: () => Promise<void>;
}

// Cache the in-flight boot PROMISE (not the resolved value): async migrations +
// scheduler.start mean two concurrent first-requests would otherwise each run
// `boot()` → double scheduler → double-fire every run. Assigning the promise
// synchronously (before the first await) makes concurrent callers share it.
const g = globalThis as unknown as { __pievoBooted?: Promise<Booted> };

export function ensureServer(): Promise<Booted> {
  if (g.__pievoBooted) return g.__pievoBooted;
  const p = boot();
  g.__pievoBooted = p;
  // If boot fails, allow a later call to retry.
  p.catch(() => {
    if (g.__pievoBooted === p) g.__pievoBooted = undefined;
  });
  return p;
}

async function boot(): Promise<Booted> {
  await runMigrations();
  await repairTerminalRunLeases();

  const abort = new AbortController();
  // Close PGlite on clean shutdown. The managed launcher awaits `shutdown`;
  // abort listeners retain the best-effort signal path.
  let closePromise: Promise<void> | undefined;
  const close = () => closePromise ??= closeClient();
  abort.signal.addEventListener("abort", () => void close(), { once: true });
  const shutdown = async () => {
    abort.abort();
    await close();
  };
  // Break the scheduler↔gateway cycle: the scheduler holds a thin dispatcher
  // that delegates to the gateway (assigned before any tick can fire).
  let gateway: MachineGateway;
  const dispatcher: Dispatcher = { dispatch: (loop) => gateway.dispatcher.dispatch(loop) };
  const scheduler = new Scheduler(dispatcher);
  gateway = new MachineGateway(scheduler);
  const cliGateway = new CliGateway(gateway);

  await scheduler.start(abort.signal);

  // A rejected promise from a bare timer callback is an unhandled rejection that
  // can terminate Node; log it and keep the interval ticking.
  const sweep = setInterval(
    () => void gateway.sweep().catch((err) => logger.error({ err: String(err) }, "sweep tick failed")),
    ONLINE_TTL_MS,
  );
  sweep.unref?.();
  abort.signal.addEventListener("abort", () => clearInterval(sweep), { once: true });

  logger.info("pievo server booted");
  return { scheduler, gateway, cliGateway, abort, shutdown };
}

export async function getGateway(): Promise<MachineGateway> {
  return (await ensureServer()).gateway;
}

export async function getCliGateway(): Promise<CliGateway> {
  return (await ensureServer()).cliGateway;
}
