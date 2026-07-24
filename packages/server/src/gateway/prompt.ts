/**
 * Builds the per-run prompts on the SERVER, to ship inside a delivery (the machine
 * just writes the prompt to a file and runs claude with it). Ported from c0's
 * loop-prompt.ts, bound to the new Loop row and the renamed `pievo` CLI. Prompt
 * prose lives as markdown loaded + `{{token}}`-filled here. ALL prompt prose lives
 * under src/skill/: public authoring references in skill/references/, and the
 * INTERNAL run prompts (exec-core, steer) in skill/run/ —
 * server-side run-dispatch only, never served or bundled. The `evolve` text is the
 * SINGLE source of truth shared with the installable agent skill
 * (skill/references/evolve.md) — run-dispatch and the skill read the same file, so
 * the evolution guidance can't drift. The shared dashboard reference is appended
 * to evolve/steer turns so UI mutation remains self-contained. `steer` is a run-token
 * verb prompt with no authoring twin (see skill/references/update.md for the owner CLI).
 *
 * Run-experience redesign, Batch 1: the exec run's instructions now live entirely
 * in the FIRST USER TURN (`buildExecTask` ← exec-core.md), not the system prompt.
 * `buildLoopSystemPrompt` returns "" — the daemon still writes it to the sys file
 * and passes `--append-system-prompt-file`, but an empty file is a harmless no-op
 * on every existing daemon (so this ships server-first, no daemon change). exec-core
 * is the self-sufficient CORE (identity + untrusted-data guard + the non-negotiable
 * fallback core + per-run trigger + a pointer to the installable pievo skill for
 * the deep protocol). The public runtime depth lives in references/run.md.
 *
 * EVOLVE and STEER follow the same first-user-turn model. All three roles receive
 * their durable run index plus the task file, execution workspace, loop content
 * home, and inferred sibling COOKBOOK.md paths.
 * Runtime history is never inlined into delivery: evolve/steer gather only bounded,
 * progressively filtered evidence through `pievo log`.
 */
import type { Loop, MetricField } from "../db/schema.js";

// Inlined at build time (Vite ?raw) so the prompt prose ships inside the nitro
// bundle. Reading them from disk at runtime broke in prod: nitro bundles JS only,
// so the `*.md` source files don't exist under .output and poll() threw ENOENT.
// `?raw` resolves identically from skill/run/ as it did from scheduler/prompts/.
import execCore from "../skill/run/exec-core.md?raw";
import evolve from "../skill/references/evolve.md?raw";
import dashboard from "../skill/references/dashboard.md?raw";
import steer from "../skill/run/steer.md?raw";

const PROMPTS: Record<string, string> = {
  "exec-core": execCore,
  evolve,
  dashboard,
  steer,
};

function loadPrompt(name: string): string {
  const v = PROMPTS[name];
  if (v === undefined) throw new Error(`unknown prompt: ${name}`);
  return v.trim();
}

function fillVars(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (m, k) => vars[k] ?? m);
}

/** Infer the bounded learned-context file beside taskFile without persisting a
 * second path. Preserve whichever separator the task path uses. */
export function cookbookPathForTaskFile(taskFile: string | null | undefined): string {
  if (!taskFile) return "COOKBOOK.md";
  const slash = Math.max(taskFile.lastIndexOf("/"), taskFile.lastIndexOf("\\"));
  return slash < 0 ? "COOKBOOK.md" : `${taskFile.slice(0, slash + 1)}COOKBOOK.md`;
}

function goalLine(loop: Loop): string {
  return loop.goal ? `Objective: ${loop.goal}` : "Objective: (none configured; follow task-file ## Spec)";
}

/** One-line human description of a loop's metric schema: `key (unit) — label; …`. */
function formatSchemaFields(schema: MetricField[]): string {
  return schema.map((f) => `${f.key}${f.unit ? ` (${f.unit})` : ""}${f.label ? ` — ${f.label}` : ""}`).join("; ");
}

/** The schema-derived `pievo report` grammar line for a loop's metric charts. */
function metricReportLine(loop: Loop): string {
  const schema = loop.metricSchema ?? [];
  return schema.length
    ? `pievo report --status kept|no-change|blocked --message "<concise result or no-go reason>" --metrics '{${schema.map((f) => `"${f.key}":<number|null>`).join(",")}}'
  # exec runs MUST include every declared metric key. Fields (keys must match exactly):
  #   ${formatSchemaFields(schema)}
  # Use finite numbers for observed values, and null for a declared metric that was not produced this run
  # (for example a failed experiment, blocked check, or missing measurement). Negative values are valid observations.
  # Big payloads: --metrics-file <path>. --message is always required.`
    : `pievo report --status kept|no-change|blocked --message "<concise result or no-go reason>"
  # this loop has no metric schema, so this run records no chart metrics.
  # --message is always required; do not pass --metrics.
  # to start charting a trend, an evolve/steer pass can define a metric schema first.`;
}

/**
 * The standing system prompt is now EMPTY: the exec run's instructions moved into
 * the first user turn (`buildExecTask`, see the run-experience redesign / Batch 1).
 * The daemon still writes this to the sys file and passes `--append-system-prompt-file`,
 * so returning "" makes that flag a harmless no-op on every existing daemon — the
 * prompt move ships server-first with no daemon change (design §5.2). Kept as a
 * function so callers/wiring stay stable; retire once the daemon drops the flag.
 */
export function buildLoopSystemPrompt(_loop: Loop): string {
  return "";
}

/**
 * The per-run user turn — now the FULL exec CORE (identity, untrusted-data guard,
 * the non-negotiable inline fallback core, the report grammar, the per-run
 * trigger, and a pointer to the installable pievo skill for the deep protocol).
 * Self-sufficient by design: the skill is enrichment, never a dependency (§3.1). A
 * goal-bearing loop injects its standing objective as an `Objective: <goal>` line —
 * prompt-injected so it wins over the file per the trust hierarchy. `{{metricLine}}`
 * carries the schema-derived report grammar.
 */
export function buildExecTask(loop: Loop, runIndex: number): string {
  const name = loop.name || loop.id;
  const taskFile = loop.taskFile ?? "README.md (missing — create it with one ## Spec)";
  const cookbookPath = cookbookPathForTaskFile(loop.taskFile);
  const metricLine = metricReportLine(loop);
  return fillVars(loadPrompt("exec-core"), {
    name,
    taskFile,
    cookbookPath,
    workdir: loop.workdir ?? "(daemon-selected scratch directory)",
    runIndex: String(runIndex),
    goalLine: goalLine(loop),
    metricLine,
  });
}

/**
 * The evolve system prompt is now EMPTY (like exec, Batch 1): the standing evolve
 * prose moved into the first user turn, concatenated ahead of the payload by
 * `buildEvolveTask`. Returning "" makes the daemon's `--append-system-prompt-file`
 * a harmless no-op on every existing daemon (ships server-first). Kept as a function
 * so delivery wiring stays stable; retire once the daemon drops the flag.
 */
export function buildEvolvePrompt(): string {
  return "";
}

/**
 * The steer system prompt is now EMPTY (like exec/evolve, Batch 2): the short steer
 * CORE moved into the first user turn, concatenated ahead of the payload by
 * `buildSteerTask`. Same server-first, harmless-no-op rationale as the others.
 */
export function buildSteerPrompt(): string {
  return "";
}

/** The steer user turn: authoritative owner instruction plus identity. Current
 * config/history stay behind `show --json` and bounded `log` reads. */
export function buildSteerTask(loop: Loop, instruction: string, runIndex: number): string {
  return [
    loadPrompt("steer"),
    loadPrompt("dashboard"),
    `[loop steer #${runIndex} · ${loop.name || loop.id}]`,
    `Objective: ${loop.goal ?? "(none configured; follow task-file ## Spec)"}`,
    `Execution workspace (cwd): ${loop.workdir ?? "(daemon-selected scratch directory)"}`,
    `Task file: ${loop.taskFile ?? "README.md (missing — create it with one ## Spec)"}`,
    "Loop content home: the directory containing the Task file above (not necessarily cwd)",
    `Cookbook: ${cookbookPathForTaskFile(loop.taskFile)}`,
    `The owner's instruction (authoritative steering):\n${instruction.trim()}`,
    "Apply it now, record one validation pending boundary, then run exactly one `pievo report --status kept|no-change|blocked --message \"<concise summary>\"`. This steer does not advance `Consolidated through`. Steer runs never pass `--metrics`.",
  ].join("\n\n");
}

/** The evolution user turn. History/config are intentionally not inlined; the
 * shared evolve protocol gathers them progressively through the CLI. */
export function buildEvolveTask(loop: Loop, runIndex: number): string {
  return [
    loadPrompt("evolve"),
    loadPrompt("dashboard"),
    `[loop evolve #${runIndex} · ${loop.name || loop.id}]`,
    `Objective: ${loop.goal ?? "(none configured; follow task-file ## Spec)"}`,
    `Execution workspace (cwd): ${loop.workdir ?? "(daemon-selected scratch directory)"}`,
    `Task file: ${loop.taskFile ?? "README.md (missing — create it with one ## Spec)"}`,
    "Loop content home: the directory containing the Task file above (not necessarily cwd)",
    `Cookbook: ${cookbookPathForTaskFile(loop.taskFile)}`,
    "Evolve this loop per the protocol above. Finish with exactly one `pievo report --status kept|no-change|blocked --message \"<concise summary>\"`. Evolve runs never pass `--metrics` and never notify the user.",
  ].join("\n\n");
}
