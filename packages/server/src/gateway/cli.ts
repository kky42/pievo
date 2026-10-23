/**
 * `/api/machine/cli` verb router. Authority keys on credential type: a device
 * (`dk_`) token gets owner verbs over loops bound to its machine, reusing
 * `MachineGateway`'s owner methods; a run (`rk_`) token gets no verb, because a
 * run reports only through its final response.
 */
import path from "node:path";

import * as store from "../db/store.js";
import type { Loop, NewRun, Run } from "../db/schema.js";
import { machinePresence, type MachinePresence } from "../lib/machinePresence.js";
import { logger } from "../logger.js";
import { resolveLease } from "./tokens.js";
import { authenticateDeviceToken } from "./deviceAuth.js";
import { DAEMON_PROTOCOL_VERSION } from "./protocol.js";
import {
  codeForStatus,
  detailBlock,
  doc,
  emptyList,
  errorBlock,
  helpBlock,
  kvLine,
  listBlock,
  type Scalar,
} from "./toon.js";
import {
  EDITABLE_LOOP_FIELDS,
  LOG_RUNS_DEFAULT,
  fmtTime,
  fmtTimeZoned,
  nextFires,
  runResultToken,
  type MachineGateway,
} from "./index.js";
import { EMPTY_SHA256, fileLimitLabel, loopFileIssue, loopFileNames } from "./loopFiles.js";
import { canonicalLoopEnvelope, scheduleFromLoop } from "./loopConfig.js";
import { readLoopHistory } from "./history.js";
import { stripNul, type HttpResult } from "./http.js";

export interface CliGatewayDeps {
  pauseLoopState?: typeof store.pauseLoopState;
  forceDeleteLoop?: typeof store.forceDeleteLoop;
  destructiveLog?: (event: Record<string, unknown>) => void;
}

const cliLog = logger.child({ mod: "cli" });

export class CliGateway {
  private readonly pauseLoopState: typeof store.pauseLoopState;
  private readonly forceDeleteLoop: typeof store.forceDeleteLoop;
  private readonly destructiveLog: (event: Record<string, unknown>) => void;

  constructor(
    /** The run-lifecycle core: CLI verbs reuse its owner methods and scheduler.
     * History authorization stays here; query/rendering lives in `history.ts`. */
    private readonly gateway: MachineGateway,
    deps: CliGatewayDeps = {},
  ) {
    this.pauseLoopState = deps.pauseLoopState ?? store.pauseLoopState;
    this.forceDeleteLoop = deps.forceDeleteLoop ?? store.forceDeleteLoop;
    this.destructiveLog = deps.destructiveLog ?? ((event) => cliLog.warn(event, "force-delete: destructive server authority removal"));
  }

  async cli(token: string, argv: string[]): Promise<HttpResult> {
    const res = token.startsWith("dk_") ? await this.deviceCli(token, argv) : await this.runCli(token, argv);
    return finalizeCli(res);
  }

  private async deviceCli(deviceToken: string, argv: string[]): Promise<HttpResult> {
    const auth = await authenticateDeviceToken(deviceToken, { allowUnknown: true });
    if (!auth.ok) return auth.response;
    const { machineId, machine } = auth;
    const verb = argv[0] ?? "";
    // Bare `pievo` renders a useful not-connected state rather than a 401.
    // handled BEFORE the unknown-machine guard the other verbs sit behind.
    if (verb === "home") return { status: 200, body: { ok: true, text: await this.homeDevice(machineId, parseFlags(argv.slice(1))) } };
    if (!machine) return { status: 401, body: { error: "unknown machine (token not registered)" } };
    const flags = parseFlags(argv.slice(1));
    const loopArg = typeof flags["loop"] === "string" ? (flags["loop"] as string) : typeof flags["_"] === "string" ? (flags["_"] as string) : "";

    if (flags["help"] === true) {
      const h = verbHelpText(verb);
      if (h) return { status: 200, body: { ok: true, text: h } };
    }

    switch (verb) {
      case "new": {
        const parsed = parseJsonFlag(flags["json"]);
        if (!parsed.ok) return { status: 400, body: { error: parsed.error } };
        const config = { ...parsed.value } as Record<string, unknown>;
        if (flags["dry-run"] === true) config.dryRun = true;
        return this.gateway.createLoop(deviceToken, config);
      }
      case "loops":
        return this.gateway.listLoops(deviceToken, typeof flags["fields"] === "string" ? (flags["fields"] as string) : undefined, flags["json"] === true);
      case "pause":
        return this.pauseOwnerLoop(machineId, loopArg);
      case "start":
        return this.startOwnerLoop(machineId, loopArg);
      case "stop":
        return this.stopOwnerLoop(machineId, loopArg);
      case "delete":
        return this.deleteOwnerLoop(
          machineId,
          loopArg,
          flags["force"] === true,
          typeof flags["confirmation"] === "string" ? flags["confirmation"] as string : undefined,
        );
      case "run":
        return this.stopOwnerRun(machineId, argv);
      case "edit": {
        const parsed = parseJsonFlag(flags["json"]);
        if (!parsed.ok) return { status: 400, body: { error: parsed.error } };
        return this.gateway.editLoop(deviceToken, loopArg || undefined, parsed.value as Record<string, unknown>, flags["dry-run"] === true);
      }
      case "log": {
        const loop = await this.ownedLoop(machineId, loopArg);
        if (!loop) return { status: 404, body: { error: "no such loop on this machine" } };
        return readLoopHistory(loop, flags);
      }
      case "show": {
        // Device `show` may inspect ANY loop bound to the machine; the machine-scope
        // check mirrors loopLog/editLoop (flat 404, existence never leaks).
        const loop = loopArg ? await store.getLoop(loopArg) : undefined;
        if (!loop || loop.machineId !== machineId) return { status: 404, body: { error: "no such loop on this machine" } };
        if (flags["json"] === true) {
          const env = loopEnvelope(loop);
          return { status: 200, body: { ok: true, loop: env, text: JSON.stringify(env, null, 2) } };
        }
        return { status: 200, body: { ok: true, text: await this.describe(loop.id, { full: flags["full"] === true }) } };
      }
      case "file":
        return this.ownerFile(machineId, argv);
      default:
        return { status: 400, body: { error: `pievo: unknown command "${verb}" for the device credential (try: new, loops, pause, start, stop, delete, run stop, edit, log, show, file)` } };
    }
  }

  private async ownedLoop(machineId: string, loopId: string): Promise<Loop | undefined> {
    if (!loopId) return undefined;
    const loop = await store.getLoop(loopId);
    return loop?.machineId === machineId ? loop : undefined;
  }

  private async pauseOwnerLoop(machineId: string, loopId: string): Promise<HttpResult> {
    const loop = await this.ownedLoop(machineId, loopId);
    if (!loop) return { status: 404, body: { error: "no such loop on this machine" } };
    const paused = await this.pauseLoopState(loop.id);
    if (!paused) return { status: 404, body: { error: "no such loop on this machine" } };
    this.gateway.scheduler.removeLoop(loop.id);
    return { status: 200, body: { text: paused.running ? PAUSED_FINISHING : "loop paused; future runs disabled" } };
  }

  private async startOwnerLoop(machineId: string, loopId: string): Promise<HttpResult> {
    const loop = await this.ownedLoop(machineId, loopId);
    if (!loop) return { status: 404, body: { error: "no such loop on this machine" } };
    if (loop.deleteRequestedAt) return { status: 409, body: { error: "loop is being deleted and cannot be started" } };
    const started = await store.startLoop(loop.id);
    if (!started) return { status: 409, body: { error: "loop could not be started" } };
    this.gateway.scheduler.addLoop(started);
    return { status: 200, body: { text: "loop started; preserved queued work is now eligible" } };
  }

  private async requireStopProtocol(machineId: string, running: NewRun | undefined): Promise<HttpResult | undefined> {
    if (!running) return undefined;
    const machine = await store.getMachine(machineId);
    if (machine?.daemonProtocol === DAEMON_PROTOCOL_VERSION) return undefined;
    return { status: 426, body: { text: STOP_UPGRADE_REQUIRED, exitCode: 1 } };
  }

  private async stopOwnerLoop(machineId: string, loopId: string): Promise<HttpResult> {
    const loop = await this.ownedLoop(machineId, loopId);
    if (!loop) return { status: 404, body: { error: "no such loop on this machine" } };
    const target = await store.runningRunForLoop(loop.id);
    const upgrade = await this.requireStopProtocol(machineId, target);
    if (upgrade) return upgrade;
    const result = await store.stopLoop(loop.id);
    this.gateway.scheduler.removeLoop(loop.id);
    if (!result) return { status: 404, body: { error: "no such loop on this machine" } };
    const machine = await store.getMachine(machineId);
    return { status: 200, body: { text: result.running ? `stop requested; waiting for ${machine?.name || "machine"}` : "loop paused; queued work canceled; no current run" } };
  }

  private async deleteOwnerLoop(machineId: string, loopId: string, force: boolean, confirmation?: string): Promise<HttpResult> {
    const loop = await this.ownedLoop(machineId, loopId);
    if (!loop) return { status: 404, body: { error: "no such loop on this machine" } };
    if (force) {
      if (!loop.deleteRequestedAt) return { status: 409, body: { error: "delete must be requested first" } };
      if (confirmation !== FORCE_DELETE_CONFIRMATION) return { status: 400, body: { error: "force delete confirmation required" } };
      const machine = await store.getMachine(machineId);
      const reachability = machinePresence(!!machine?.online, machine?.lastSeen ?? null);
      const deleted = await this.forceDeleteLoop(loop.id);
      if (!deleted) return { status: 409, body: { error: "force delete failed; server data was not deleted" } };
      this.gateway.scheduler.removeLoop(loop.id);
      this.destructiveLog({ action: "force-delete", loopId: loop.id, machineId, machineReachability: reachability });
      return { status: 200, body: { text: forceDeleteWarning(reachability) } };
    }
    const target = await store.runningRunForLoop(loop.id);
    const upgrade = await this.requireStopProtocol(machineId, target);
    if (upgrade) return upgrade;
    const result = await store.requestDeleteLoop(loop.id);
    this.gateway.scheduler.removeLoop(loop.id);
    if (!result) return { status: 404, body: { error: "no such loop on this machine" } };
    if (await store.tryDeleteLoop(loop.id)) return { status: 200, body: { text: "loop deleted; local project files were not deleted" } };
    const machine = await store.getMachine(machineId);
    return { status: 200, body: { text: `delete requested; stop requested; waiting for ${machine?.name || "machine"}` } };
  }

  private async stopOwnerRun(machineId: string, argv: string[]): Promise<HttpResult> {
    if (argv[1] !== "stop" || !argv[2]) return { status: 400, body: { error: "usage: pievo run stop <run>" } };
    const run = await store.getRun(argv[2]);
    if (!run || run.machineId !== machineId) return { status: 404, body: { error: "no such run on this machine" } };
    const upgrade = await this.requireStopProtocol(machineId, run.phase === "running" ? run : undefined);
    if (upgrade) return upgrade;
    const stopped = await store.requestRunCancel(run.loopId, run.id);
    if (!stopped) return { status: 404, body: { error: "no such run on this machine" } };
    if (stopped.phase === "running") {
      const machine = await store.getMachine(machineId);
      return { status: 200, body: { text: `stop requested; waiting for ${machine?.name || "machine"}` } };
    }
    if (stopped.phase === "canceled") return { status: 200, body: { text: "run canceled before it started" } };
    return { status: 200, body: { text: `run already finished: ${runResultToken(stopped)}` } };
  }

  private async runCli(runToken: string, _argv: string[]): Promise<HttpResult> {
    if (!(await resolveLease(runToken))) return { status: 401, body: { text: errorBlock("invalid or expired token", "UNAUTHORIZED"), exitCode: 1 } };
    return { status: 403, body: { text: errorBlock(RUN_HAS_NO_CLI, "FORBIDDEN"), exitCode: 1 } };
  }

  /** `file list|get|set` over one loop's files. `set` takes base64 content so
   *  arbitrary text (including leading `--`) survives argv transport. */
  private async ownerFile(machineId: string, argv: string[]): Promise<HttpResult> {
    const [, sub, loopId, name] = argv;
    const loop = loopId ? await this.ownedLoop(machineId, loopId) : undefined;
    if (sub !== "list" && sub !== "get" && sub !== "set") return { status: 400, body: { error: `usage: ${FILE_USAGE}` } };
    if (!loop) return { status: 404, body: { error: "no such loop on this machine" } };
    const names = loopFileNames(loop);
    if (sub === "list") {
      const rows = await Promise.all(names.map(async (file) => {
        const row = await store.getArtifactFile(loop.id, file);
        const live = row && !row.deleted && row.hash ? row : undefined;
        return [file, live?.size ?? 0, fileLimitLabel(file), live ? fmtTime(live.updatedAt) : null] as Scalar[];
      }));
      return { status: 200, body: { text: doc(listBlock("files", ["name", "size", "limit", "updatedAt"], rows), helpBlock([
        `Run \`pievo file get ${loop.id} <name>\` to print a file`,
        `Run \`pievo file set ${loop.id} <name> --from <path>\` to replace a file`,
      ])) } };
    }
    if (!name || !names.includes(name)) {
      return { status: 404, body: { error: `no such loop file: ${name ?? ""} (files: ${names.join(", ")})` } };
    }
    if (sub === "get") {
      const row = await store.getArtifactFile(loop.id, name);
      const bytes = await this.gateway.loopFiles.readBlob(row && !row.deleted && row.hash ? row.hash : EMPTY_SHA256);
      if (!bytes) return { status: 500, body: { error: "loop file bytes are missing" } };
      // An empty file prints as one blank line: the CLI transport requires non-empty text.
      return { status: 200, body: { text: bytes.length ? bytes.toString("utf8") : "\n" } };
    }
    const flags = parseFlags(argv.slice(4));
    const encoded = flags["content-base64"];
    // A bare flag (no value) would silently mean "empty file"; require the value.
    if (typeof encoded !== "string") return { status: 400, body: { error: `usage: ${FILE_USAGE}` } };
    const bytes = Buffer.from(encoded, "base64");
    const issue = loopFileIssue(name, bytes);
    if (issue) return { status: 413, body: { error: `${issue}; nothing was changed` } };
    const hash = await this.gateway.loopFiles.putBlob(bytes);
    if (hash !== EMPTY_SHA256) await store.recordBlob(hash, bytes.length);
    if (!(await store.writeLoopFile(loop.id, name, hash, bytes.length))) return { status: 404, body: { error: "no such loop file" } };
    return { status: 200, body: { text: `file: ${name}\nsize: ${bytes.length}\nupdated: true` } };
  }

  private async describe(loopId: string, opts: { full?: boolean } = {}): Promise<string> {
    const loop = await store.getLoop(loopId);
    if (!loop) return "loop not found";
    const recent = (await store.listRuns(loop.id, LOG_RUNS_DEFAULT)).slice().reverse();
    return renderShowText(loop, loopEnvelope(loop), await store.countRuns(loop.id), recent[0] ?? null, opts);
  }

  /**
   * Bare `pievo` renders the home for a device credential. The
   * daemon passes the local facts it alone knows as context flags (`--cwd`/`--home`
   * for directory scoping, `--bin`/`--pid`/`--server` for the header); the server owns
   * the whole TOON render (text-sink). An unregistered machine renders a DEFINITIVE
   * "not connected" state (never empty, never an error).
   */
  private async homeDevice(machineId: string, flags: Flags): Promise<string> {
    const machine = await store.getMachine(machineId);
    const ctx: HomeContext = {
      bin: typeof flags["bin"] === "string" ? (flags["bin"] as string) : null,
      pid: typeof flags["pid"] === "string" ? (flags["pid"] as string) : null,
      server: typeof flags["server"] === "string" ? (flags["server"] as string) : null,
      cwd: typeof flags["cwd"] === "string" ? (flags["cwd"] as string) : null,
      home: typeof flags["home"] === "string" ? (flags["home"] as string) : null,
    };
    if (!machine) return renderHomeText(ctx, null, [], 0, []);
    const presence = machinePresence(machine.online, machine.lastSeen);
    const loops = await store.loopsForMachine(machineId);
    const scoped = scopeLoopsByCwd(loops, ctx.cwd, ctx.home);
    const here: HomeLoop[] = await Promise.all(
      scoped.here.map(async (l) => {
        const schedule = scheduleFromLoop(l);
        return {
          id: l.id,
          name: l.name,
          cron: schedule.mode === "continuous" ? `continuous +${schedule.delayMinutes}m` : schedule.cron,
          enabled: l.enabled,
          nextFire: l.enabled && schedule.mode === "cron" ? (nextFires(schedule.cron, schedule.timezone, 1)[0] ?? null) : null,
          lastResult: await (async () => {
            const last = await store.lastRun(l.id);
            return last ? runResultToken(last) : null;
          })(),
        };
      }),
    );
    return renderHomeText(ctx, presence, here, scoped.elsewhere, await recentMachineRuns(loops, 3));
  }

}

type Flags = Record<string, string | boolean>;

const RUN_HAS_NO_CLI =
  "pievo commands are not available inside a run; end your final response with a summary and a last line `STATUS: ok|block`";
const FILE_USAGE = "pievo file list <loop> | file get <loop> <name> | file set <loop> <name> --from <path>";

const PAUSED_FINISHING = "loop paused; current run is finishing";
const STOP_UPGRADE_REQUIRED = "Daemon upgrade required to stop a running process. Run `npm install -g @kky42/pievo@latest`, then `pievo daemon restart`.";
const FORCE_DELETE_CONFIRMATION = "delete-server-data-anyway";

function forceDeleteWarning(reachability: MachinePresence): string {
  const machine = reachability === "online" ? "machine is online" : reachability === "asleep" ? "machine is asleep" : "machine is unreachable";
  return `The ${machine}. Its local process may still be running. This removes Pievo authority and server data only. Local project files are not deleted.`;
}

/** Parse a `--json '<obj>'` flag into an object. Absent → an empty object (the
 *  downstream createLoop/editLoop validators then produce the precise error, e.g.
 *  "cron required"). Present-but-not-a-JSON-object → a legible 400. Shared by the
 *  device-credential `new`/`edit` verbs of the unified CLI. */
function parseJsonFlag(raw: unknown): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  if (raw === undefined || raw === true) return { ok: true, value: {} };
  if (typeof raw !== "string") return { ok: false, error: "pievo: --json must be a JSON object string" };
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return { ok: false, error: "pievo: --json must be valid JSON (an object)" };
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return { ok: false, error: "pievo: --json must be a JSON object" };
  return { ok: true, value: obj as Record<string, unknown> };
}

/** A structured `error:`/`code:` TOON result for stdout.
 *  Mirrors the `{code, text}` shape `dispatch` returns; the slug defaults from the
 *  HTTP status but a caller may pin it (e.g. CONFLICT). */
function derr(code: number, message: string, slug?: string): { code: number; text: string } {
  return { code, text: errorBlock(message, slug ?? codeForStatus(code)) };
}

/** The structured keys a `/api/machine/cli` body may carry. The daemon renders
 * `text` and exits with `exitCode`; two structured channels remain because the
 * current daemon reads them as data:
 *   - `loops`: the daemon resolves cwd→loop CLIENT-side (`log`/`show`/`home`) from this
 *     list; the server's `log`/`show` dispatch needs an explicit id.
 *   - `runs`: the `log --json` normalized-data escape hatch. */
const CLI_RETAINED_KEYS = new Set(["text", "exitCode", "loops", "runs"]);

/** Finalize a `/api/machine/cli` body with `text` + `exitCode` and only the
 *  structured fields used by the daemon. A structured `{error}` is first
 *  rendered to `error:`/`code:` TOON so the daemon prints it to stdout. */
function finalizeCli(res: HttpResult): HttpResult {
  const b = res.body;
  if (b && typeof b === "object" && !Array.isArray(b)) {
    const body = b as Record<string, unknown>;
    if (typeof body.text !== "string" && typeof body.error === "string") {
      body.text = errorBlock(body.error, codeForStatus(res.status));
    }
    if (typeof body.exitCode !== "number") {
      body.exitCode = res.status >= 200 && res.status < 300 ? 0 : 1;
    }
    // Every CLI path renders text or sets error above. Keep the guard so a malformed
    // text-less body is not silently blanked.
    if (typeof body.text === "string") {
      for (const k of Object.keys(body)) if (!CLI_RETAINED_KEYS.has(k)) delete body[k];
    }
  }
  return res;
}

// `<verb> --help` prints syntax, a summary, and concrete examples for device
// credentials. A verb absent from the map falls through to unknown-command handling.

interface VerbHelpSpec {
  syntax: string;
  summary: string;
  help: string[];
}

const DEVICE_VERB_HELP: Record<string, VerbHelpSpec> = {
  new: {
    syntax: "new --json '<config>' [--dry-run]",
    summary: `create a loop from the canonical envelope (keys: ${[...EDITABLE_LOOP_FIELDS].join(", ")}; agent required)`,
    help: [
      "Run `pievo new --json '{\"name\":\"Daily check\",\"schedule\":{\"mode\":\"cron\",\"cron\":\"0 8 * * *\",\"timezone\":\"UTC\",\"overlap\":\"skip\"},\"workdir\":\"<path>\",\"agent\":\"claude-code\",\"prompt\":\"Check the project.\"}'` to create a loop",
      "Run `pievo new --json '{...}' --dry-run` to validate without creating",
    ],
  },
  loops: {
    syntax: "loops [--fields a,b] [--json]",
    summary: "list every loop bound to this machine",
    help: ["Run `pievo show <id>` to see a loop's full config", "Run `pievo log <id>` to see a loop's recent runs"],
  },
  edit: {
    syntax: "edit <id> --json '<patch>' [--dry-run]",
    summary: `change a loop's config using one JSON patch (keys: ${[...EDITABLE_LOOP_FIELDS].join(", ")})`,
    help: [
      "Run `pievo edit <id> --json '{\"schedule\":{\"mode\":\"continuous\",\"delayMinutes\":5}}'` to change the schedule",
      "Run `pievo edit <id> --json '{...}' --dry-run` to preview the change",
    ],
  },
  show: {
    syntax: "show [<id|unique-name>] [--full] [--json]",
    summary: "print a loop's full config + recent runs (defaults from the current directory)",
    help: ["Run `pievo loops` to list loops on this machine", "Run `pievo log <id>` to see the loop's recent runs"],
  },
  pause: {
    syntax: "pause <id>",
    summary: "pause future runs; the current run continues",
    help: ["Pause future runs? The current run will continue."],
  },
  start: {
    syntax: "start <id>",
    summary: "enable a paused loop and re-arm its existing cadence",
    help: ["Completed loops must be reopened explicitly; deleting loops cannot be started"],
  },
  stop: {
    syntax: "stop <id>",
    summary: "pause the loop, cancel queued work, and request process termination",
    help: ["Pause this loop, cancel queued work, and stop the current run if it is still running?"],
  },
  delete: {
    syntax: "delete <id> [--force]",
    summary: "stop first, then delete server history, memory, and artifacts",
    help: ["Stop this loop and delete its Pievo history, memory, and artifacts? Local project files are not deleted.", "--force requires a prior Delete request and explicit local confirmation; the local process may still be running"],
  },
  run: {
    syntax: "run stop <run-id>",
    summary: "stop one pending or running run without pausing its loop",
    help: ["A running run remains running until the daemon confirms cancellation"],
  },
  file: {
    syntax: "file list <id> | file get <id> <name> | file set <id> <name> --from <path>",
    summary: "inspect or replace a loop's MEMORY.md and artifact files",
    help: [
      "Run `pievo file get <id> MEMORY.md` to read the loop's memory",
      "An edit made while a run is executing wins over that run's version of the file",
    ],
  },
  log: {
    syntax: "log [<id>] [--limit 1..20] [--since ISO] [--until ISO] [--status ok|block] [--phase done|error|canceled] [--run <index|UUID> [--diff]] [--json]",
    summary: "bounded terminal history or one detailed run",
    help: ["Run `pievo log <id> --json` for structured history", "Run `pievo log <id> --run 12 --diff` for bounded run detail and artifact diff"],
  },
};

function verbHelpText(verb: string): string | undefined {
  const spec = DEVICE_VERB_HELP[verb];
  if (!spec) return undefined;
  return doc(
    kvLine("verb", verb),
    kvLine("syntax", spec.syntax),
    kvLine("summary", spec.summary),
    helpBlock(spec.help),
  );
}

function loopEnvelope(loop: Loop): Record<string, unknown> {
  return { ...canonicalLoopEnvelope(loop) };
}

function contentField(value: string | null, full: boolean): Scalar | { raw: string } {
  if (value == null) return "absent";
  if (full) return value; // scalar() quotes the full body (newlines escaped to one line)
  return { raw: `present, ${value.length} bytes — use --full to see` };
}

function nextFireDisplay(loop: Loop): string {
  const schedule = scheduleFromLoop(loop);
  if (schedule.mode === "continuous") return `after exec terminal + ${schedule.delayMinutes}m`;
  const iso = nextFires(schedule.cron, schedule.timezone, 1)[0];
  if (!iso) return "(never)";
  return fmtTimeZoned(iso, schedule.timezone, { seconds: true });
}

function renderShowText(
  loop: Loop,
  env: Record<string, unknown>,
  totalRuns: number,
  lastRun: Pick<Run, "phase" | "status" | "ts" | "error" | "reportIncident"> | null,
  opts: { full?: boolean } = {},
): string {
  const full = opts.full === true;
  const block = detailBlock("loop", [
    ["id", env.id as Scalar],
    ["name", env.name as Scalar],
    ["tags", { raw: JSON.stringify(env.tags) }],
    ["schedule", { raw: JSON.stringify(env.schedule) }],
    ["workdir", env.workdir as Scalar],
    ["agent", env.agent as Scalar],
    ["model", env.model == null ? { raw: "default" } : env.model as Scalar],
    ["reasoningEffort", env.reasoningEffort == null ? { raw: "default" } : env.reasoningEffort as Scalar],
    ["prompt", contentField(loop.prompt, full)],
    ["artifacts", { raw: JSON.stringify(env.artifacts) }],
    ["enabled", env.enabled as Scalar],
  ]);
  const runsTally = lastRun
    ? `${totalRuns} total · last ${runResultToken(lastRun)} ${fmtTime(lastRun.ts)}`
    : `${totalRuns} total`;
  const help = [
    `Run \`pievo show ${loop.id} --full\` to see the complete prompt`,
    `Run \`pievo edit ${loop.id} --json '{"schedule":{"mode":"continuous","delayMinutes":5}}'\` to change the schedule`,
    `Run \`pievo log ${loop.id}\` to see recent run results`,
    `Run \`pievo file list ${loop.id}\` to see the loop's memory and artifact files`,
  ];
  return doc(
    block,
    kvLine("nextFire", nextFireDisplay(loop)),
    `lifecycle: ${loop.enabled ? "active" : "paused"}`,
    `runs: ${runsTally}`,
    !loop.enabled
      ? kvLine("pauseCause", loop.pauseCause?.kind === "failure-streak"
          ? `failure-streak (run ${loop.pauseCause.runId}, count ${loop.pauseCause.count})`
          : loop.pauseCause?.kind === "blocked"
            ? `blocked (run ${loop.pauseCause.runId})`
            : loop.pauseCause?.kind === "owner" ? "owner" : "unknown")
      : null,
    lastRun?.reportIncident
      ? kvLine("reportIncident", `${lastRun.reportIncident.code} · ${lastRun.reportIncident.faultDomain} · ${lastRun.reportIncident.reason}`)
      : null,
    helpBlock(help),
  );
}

interface HomeContext {
  bin: string | null;
  pid: string | null;
  server: string | null;
  cwd: string | null;
  home: string | null;
}

interface HomeLoop {
  id: string;
  name: string;
  cron: string;
  enabled: boolean;
  nextFire: string | null;
  lastResult: string | null;
}

const HOME_DESCRIPTION = "Run your scheduled Pievo agent loops on this machine with your own coding agent.";

/** Expand a leading `~/` against the daemon-supplied home dir (the SERVER's own home
 *  is irrelevant — a loop's paths are the daemon machine's). Absent home ⇒ unchanged. */
function expandHome(p: string, home: string | null): string {
  return home && p.startsWith("~/") ? path.join(home, p.slice(2)) : p;
}

function scopeLoopDir(workdir: string, home: string | null): string {
  return path.resolve(expandHome(workdir, home));
}

/**
 * Partition a machine's loops into the ones rooted at (or under) `cwd` — the
 * directory-scoped ambient context and a count of the rest. With no cwd
 * (or none matching), ALL loops are "here" (elsewhere 0): a home run from an
 * unrelated directory still shows the whole machine rather than nothing.
 */
export function scopeLoopsByCwd(
  loops: Loop[],
  cwd: string | null,
  home: string | null,
): { here: Loop[]; elsewhere: number } {
  if (!cwd) return { here: loops, elsewhere: 0 };
  const here = path.resolve(cwd);
  const matched = loops.filter((l) => {
    const dir = scopeLoopDir(l.workdir, home);
    return here === dir || here.startsWith(dir + path.sep);
  });
  if (matched.length === 0) return { here: loops, elsewhere: 0 };
  return { here: matched, elsewhere: loops.length - matched.length };
}

async function recentMachineRuns(loops: Loop[], n: number): Promise<Array<{ ts: string; loop: string; result: string }>> {
  const rows: Array<{ ts: string; loop: string; result: string }> = [];
  for (const l of loops) {
    for (const r of await store.listRuns(l.id, n)) {
      rows.push({ ts: r.ts, loop: l.name, result: runResultToken(r) });
    }
  }
  rows.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
  return rows.slice(0, n);
}

/** The device home: `bin:`/`description:`/`machine:` header, the cwd-scoped
 *  loop list, recent runs, and a `help[]`. `presence` null ⇒ the machine is not
 *  registered → a DEFINITIVE "not connected" state (never empty, never an error). */
function renderHomeText(
  ctx: HomeContext,
  presence: MachinePresence | null,
  here: HomeLoop[],
  elsewhere: number,
  recent: Array<{ ts: string; loop: string; result: string }>,
): string {
  const machineLine =
    presence === null
      ? "machine: not connected — run `pievo daemon connect`"
      : `machine: ${[presence, ctx.pid ? `daemon pid ${ctx.pid}` : null, ctx.server].filter(Boolean).join(" · ")}`;
  const binLineText = ctx.bin ? kvLine("bin", ctx.bin) : "bin: (not on PATH — run `npm install -g @kky42/pievo@latest`)";
  // Not connected: the header + the definitive state + how to connect. No loop/run
  // blocks (there's nothing to show), but never empty output.
  if (presence === null) {
    return doc(
      binLineText,
      kvLine("description", HOME_DESCRIPTION),
      machineLine,
      helpBlock([
        "Run `pievo daemon connect --server-url <url> --connect-key <dk_…>` to connect this machine",
        "Run `pievo --help` to see every command",
      ]),
    );
  }
  const loopsName = elsewhere > 0 ? "loops here" : "loops";
  const loopsBlock = here.length
    ? listBlock(
        loopsName,
        ["name", "cron", "enabled", "nextFire", "lastResult"],
        here.map((l) => [l.name, l.cron, l.enabled ? "on" : "paused", l.nextFire ? fmtTime(l.nextFire) : null, l.lastResult]),
      )
    : emptyList(loopsName);
  const recentBlock = recent.length
    ? listBlock("recent", ["ts", "loop", "result"], recent.map((r) => [fmtTime(r.ts), r.loop, r.result]))
    : null;
  return doc(
    binLineText,
    kvLine("description", HOME_DESCRIPTION),
    machineLine,
    loopsBlock,
    elsewhere > 0 ? `loops elsewhere: ${elsewhere} more on this machine` : null,
    recentBlock,
    helpBlock([
      "Run `pievo loops` to list every loop on this machine",
      "Run `pievo show <id>` to inspect a loop, `pievo log <id>` for its runs",
      "Run `pievo new --json '{...}'` to create a loop",
    ]),
  );
}

/** Tiny flag parser: `--k v` pairs, bare `--flag` → true, first positional under `_`.
 *  Every key/value is NUL-stripped at this wire boundary before validation or
 *  persistence because Postgres text rejects NUL. */
function parseFlags(args: string[]): Flags {
  const out: Flags = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--")) {
      const key = stripNul(a.slice(2));
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        out[key] = stripNul(next);
        i++;
      } else {
        out[key] = true;
      }
    } else if (out["_"] === undefined) {
      out["_"] = stripNul(a);
    }
  }
  return out;
}
